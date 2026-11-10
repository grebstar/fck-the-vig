// fck the vig — accounts API (Cloudflare Worker + D1 database bound as DB).
// Stores a username, an email address (only used for password resets), a salted PBKDF2 password hash,
// login sessions and each user's saved bets.
//
// Password-reset emails go out through whichever of these is set up (first one wins):
//   - a Cloudflare Email Service binding named EMAIL (needs the Workers Paid plan), or
//   - a Resend API key in the secret RESEND_API_KEY (free plan: 100 emails/day).
// MAIL_FROM sets the sender (default "Screw the Vig <noreply@screwvig.com>"); SITE_URL the link target.
//
// Line-move alerts: users save alerts here; the GitHub Action that refreshes odds checks them and calls
// /api/alerts/fire, proving who it is with a GitHub Actions OIDC token (no shared secret to manage).
// Alerts go out as web push (VAPID keys are generated once and kept in the config table) and/or email.
//
// Shared bets: POST /api/share stores a bet plus a preview picture the browser drew, and returns a short link
// (/s/<id>). Texting apps read that page's preview tags and show the bet's own picture; people who open it are
// sent on to the site with the bet loaded. Pictures are dropped after SHARE_IMG_DAYS (the link keeps working).
//
// Membership: every account is Free (FREE_SAVES_PER_DAY saved bets a day, counted in Central time) or Unlimited.
// Unlimited comes from a Stripe subscription (secrets STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET, vars
// STRIPE_PRICE_MONTHLY and optionally STRIPE_PRICE_ANNUAL), from a secret code the admin hands out, or from the
// admin granting it by username. The admin is the account whose email is in ADMIN_EMAILS (default
// cory@fckvig.com); the first account with that email to open the admin page is pinned as the admin.

const ORIGINS = ['https://www.screwvig.com', 'https://screwvig.com', 'https://www.fckvig.com', 'https://fckvig.com', 'https://grebstar.github.io', 'capacitor://localhost'];  // last one = the iPhone app
let allowed = new Set(ORIGINS);  // ALLOW_ORIGINS (comma-separated) overrides this, e.g. for local testing
const SESSION_DAYS = 90;
const PBKDF2_ITER = 100000;          // Workers' maximum
const MAX_BETS = 1000;
const MAX_BET_BYTES = 8000;
const MAX_BODY = 600000;
const USER_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESET_MINUTES = 60;
const MAX_ALERTS = 25;               // active alerts per user
const ALERT_MAIL_PER_USER_DAY = 10;
const ALERT_MAIL_PER_DAY = 80;       // Resend's free plan allows 100/day; leave room for password resets
const GITHUB_REPO = 'grebstar/fck-the-vig';
const OIDC_AUDIENCE = 'fckvig-api';
const SHARE_IMG_DAYS = 30;           // keep a shared bet's preview picture this long
const SHARE_DAYS = 365;              // and the link itself this long
const SHARE_MAX_IMG = 300000;        // bytes (the site sends a ~60-150 KB JPEG)
const SHARE_MAX_IMGS = 2500;         // newest pictures kept in the database (~250 MB at most; D1 free allows 500 MB)
const SHARE_MAX_LEGS = 12;
const FREE_SAVES_PER_DAY = 2;        // env FREE_SAVES_PER_DAY overrides
const PLAN_TZ = 'America/Chicago';   // the free daily count resets at midnight here
const ADMIN_EMAILS = 'cory@fckvig.com,cory@screwvig.com';
const STRIPE_GRACE_DAYS = 3;         // keep Unlimited this long past a period end while Stripe retries a card
const CODE_RE = /^[A-Z0-9-]{4,32}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pw TEXT NOT NULL, created_at INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS bets (user_id INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id))`,
  `CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_subs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id)`,
  `CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, spec TEXT NOT NULL, mode TEXT NOT NULL, target INTEGER, base_price INTEGER, base_point REAL, books TEXT NOT NULL, channels TEXT NOT NULL, commence INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', sent_at INTEGER, message TEXT)`,
  `CREATE INDEX IF NOT EXISTS alerts_user ON alerts (user_id)`,
  `CREATE INDEX IF NOT EXISTS alerts_status ON alerts (status)`,
  `CREATE TABLE IF NOT EXISTS prefs (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, legs TEXT NOT NULL, stake REAL, title TEXT NOT NULL, descr TEXT NOT NULL, img TEXT, mime TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS shares_created ON shares (created_at)`,
  `CREATE TABLE IF NOT EXISTS saves (user_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (user_id, day))`,
  `CREATE TABLE IF NOT EXISTS codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, label TEXT NOT NULL, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, grant_days INTEGER, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS redemptions (code_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (code_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS redemptions_user ON redemptions (user_id)`,
];
// Columns added to users after launch: [name, SQL type].
const USER_COLS = [
  ['email', 'TEXT'],
  ['plan', "TEXT NOT NULL DEFAULT 'free'"],   // 'free' | 'unlimited'
  ['plan_until', 'INTEGER'],                  // ms; NULL with plan 'unlimited' = no end date
  ['plan_source', 'TEXT'],                    // 'stripe' | 'code' | 'admin'
  ['plan_code', 'INTEGER'],                   // codes.id when plan_source = 'code'
  ['stripe_customer', 'TEXT'],
  ['stripe_sub', 'TEXT'],
  ['stripe_status', 'TEXT'],
];
let schemaReady = null;
async function migrate(db) {
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  // Add columns that came after launch to databases created before them.
  const cols = new Set(((await db.prepare('PRAGMA table_info(users)').all()).results || []).map(c => c.name));
  for (const [name, type] of USER_COLS) if (!cols.has(name)) await db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${type}`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS users_stripe ON users (stripe_customer)').run();
  // When daily limits switched on. Bets made before this (saved in a browser while signed out) merge in free.
  await db.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('limits_start', ?)").bind(String(Date.now())).run();
}
const ensureSchema = db => (schemaReady ||= migrate(db).catch(e => { schemaReady = null; throw e; }));

// ---------- helpers ----------
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const fromB64url = s => unb64(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function checkPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

function cors(req) {
  const o = req.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  if (o && allowed.has(o)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
const json = (req, body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors(req) },
});
const fail = (req, status, error) => json(req, { error }, status);

async function body(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Too much data.');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Too much data.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Bad request.'); }
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Fixed-window rate limit stored in D1.
async function limit(db, key, max, windowMs) {
  const now = Date.now();
  const row = await db.prepare('SELECT n, reset_at FROM rate WHERE k = ?').bind(key).first();
  if (!row || row.reset_at < now) {
    await db.prepare('INSERT INTO rate (k, n, reset_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = 1, reset_at = excluded.reset_at').bind(key, now + windowMs).run();
    return;
  }
  if (row.n >= max) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  await db.prepare('UPDATE rate SET n = n + 1 WHERE k = ?').bind(key).run();
}
const ipKey = async req => sha256('ip:' + (req.headers.get('CF-Connecting-IP') || 'unknown'));

async function newSession(db, userId) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 864e5).run();
  return token;
}
async function auth(req, db) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'Please sign in.');
  const th = await sha256(m[1]);
  const row = await db.prepare('SELECT s.user_id, s.expires_at, u.username, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(th).first();
  if (!row || row.expires_at < Date.now()) throw new HttpError(401, 'Your session expired. Please sign in again.');
  return { id: row.user_id, username: row.username, created_at: row.created_at, tokenHash: th };
}

function cleanUsername(u) {
  const v = String(u ?? '').trim().toLowerCase();
  if (!USER_RE.test(v)) throw new HttpError(400, 'Usernames are 3–20 letters, numbers or underscores.');
  return v;
}
function cleanEmail(e) {
  const v = String(e ?? '').trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) throw new HttpError(400, 'Enter a valid email address.');
  return v;
}
function cleanPassword(p) {
  const v = String(p ?? '');
  if (v.length < 8 || v.length > 200) throw new HttpError(400, 'Passwords need at least 8 characters.');
  return v;
}

// ---------- routes ----------
async function signup(req, db) {
  const b = await body(req);
  const username = cleanUsername(b.username);
  const email = cleanEmail(b.email);
  const password = cleanPassword(b.password);
  if (b.adult !== true) throw new HttpError(400, 'You need to confirm you are of legal betting age.');
  await limit(db, 'signup:' + await ipKey(req), 10, 3600e3);
  const exists = await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  if (exists) throw new HttpError(409, 'That username is taken.');
  const used = await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (used) throw new HttpError(409, 'That email already has an account. Use "Forgot password?" to get back in.');
  const pw = await hashPassword(password);
  const res = await db.prepare('INSERT INTO users (username, email, pw, created_at) VALUES (?, ?, ?, ?)').bind(username, email, pw, Date.now()).run();
  const id = res.meta.last_row_id;
  return json(req, { token: await newSession(db, id), username });
}

async function login(req, db) {
  const b = await body(req);
  const username = String(b.username ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  // No account lockout. The only brake is per network: 100 tries in 10 minutes, which stops password-guessing bots
  // without ever getting in a person's way.
  await limit(db, 'login:' + await ipKey(req), 100, 10 * 60e3);
  const byEmail = username.includes('@');
  const u = byEmail || USER_RE.test(username)
    ? await db.prepare(`SELECT id, username, pw FROM users WHERE ${byEmail ? 'email' : 'username'} = ?`).bind(username).first() : null;
  const ok = u ? await checkPassword(password, u.pw) : (await pbkdf2(password, new Uint8Array(16), PBKDF2_ITER), false);
  if (!ok) throw new HttpError(401, 'Wrong username or password.');
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(u.id, Date.now()).run();
  return json(req, { token: await newSession(db, u.id), username: u.username });
}

async function logout(req, db) {
  const u = await auth(req, db);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(u.tokenHash).run();
  return json(req, { ok: true });
}

async function me(req, db, env) {
  const u = await auth(req, db);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM bets WHERE user_id = ? AND deleted = 0').bind(u.id).first();
  const row = await userRow(db, u.id);
  return json(req, {
    username: u.username, email: row?.email || null, created_at: u.created_at, bets: n?.n || 0,
    ...(await membership(db, env, row)),
  });
}

async function changeEmail(req, db) {
  const u = await auth(req, db);
  const b = await body(req);
  const email = cleanEmail(b.email);
  const row = await db.prepare('SELECT pw FROM users WHERE id = ?').bind(u.id).first();
  if (!row || !(await checkPassword(String(b.password ?? ''), row.pw))) throw new HttpError(401, 'Wrong password.');
  const used = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (used && used.id !== u.id) throw new HttpError(409, 'That email is already on another account.');
  await db.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, u.id).run();
  return json(req, { ok: true, email });
}

// ---------- password reset by email ----------
function mailerReady(env) { return !!(env.EMAIL || env.RESEND_API_KEY); }

async function sendMail(env, { to, subject, text, html }) {
  const from = env.MAIL_FROM || 'Screw the Vig <noreply@screwvig.com>';
  if (env.EMAIL) {
    const m = /^(.*)<(.+)>$/.exec(from);
    await env.EMAIL.send({ from: m ? { name: m[1].trim(), email: m[2].trim() } : from, to, subject, text, html });
    return;
  }
  const res = await fetch(env.RESEND_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function forgot(req, db, env) {
  const b = await body(req);
  const who = String(b.who ?? '').trim().toLowerCase();
  if (!who) throw new HttpError(400, 'Enter your email or username.');
  if (!mailerReady(env)) throw new HttpError(503, "Password reset emails aren't switched on yet. Please try again later.");
  await limit(db, 'forgot:' + await ipKey(req), 10, 3600e3);
  const u = await db.prepare(`SELECT id, username, email FROM users WHERE ${who.includes('@') ? 'email' : 'username'} = ?`).bind(who).first();
  // Same answer whether or not the account exists, so this can't be used to look up who has an account.
  const done = json(req, { ok: true });
  if (!u || !u.email) return done;
  try { await limit(db, 'forgot-user:' + u.id, 5, 3600e3); } catch { return done; }
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM resets WHERE user_id = ? OR expires_at < ?').bind(u.id, now),
    db.prepare('INSERT INTO resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), u.id, now, now + RESET_MINUTES * 60e3),
  ]);
  const link = `${(env.SITE_URL || 'https://screwvig.com').replace(/\/$/, '')}/#reset=${token}`;
  const text = `Hi ${u.username},\n\nSomeone (hopefully you) asked to reset the password for your Screw the Vig account.\n\nSet a new password here (the link works for ${RESET_MINUTES} minutes):\n${link}\n\nIf you didn't ask for this, ignore this email. Your password won't change.\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#14062e">
<p>Hi ${u.username},</p>
<p>Someone (hopefully you) asked to reset the password for your <b>Screw the Vig</b> account.</p>
<p><a href="${link}" style="display:inline-block;background:#9b74ff;color:#14062e;font-weight:700;padding:12px 20px;border-radius:12px;text-decoration:none">Set a new password</a></p>
<p style="font-size:14px;color:#555">The link works for ${RESET_MINUTES} minutes. If you didn't ask for this, ignore this email. Your password won't change.</p></div>`;
  try {
    await sendMail(env, { to: u.email, subject: 'Reset your Screw the Vig password', text, html });
  } catch (err) {
    console.error('reset email failed', err);
    throw new HttpError(502, "We couldn't send the email just now. Please try again in a few minutes.");
  }
  return done;
}

async function resetPassword(req, db) {
  const b = await body(req);
  const token = String(b.token ?? '');
  const password = cleanPassword(b.password);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'This reset link is broken. Ask for a new one.');
  const th = await sha256(token);
  const row = await db.prepare('SELECT r.user_id, r.expires_at, u.username FROM resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?').bind(th).first();
  if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
  await db.batch([
    db.prepare('UPDATE users SET pw = ? WHERE id = ?').bind(await hashPassword(password), row.user_id),
    db.prepare('DELETE FROM resets WHERE user_id = ?').bind(row.user_id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),   // sign out everywhere else
  ]);
  return json(req, { token: await newSession(db, row.user_id), username: row.username });
}

// Merge the client's bets with the stored ones (newest `updated` wins) and return everything.
async function syncBets(req, db, env) {
  const u = await auth(req, db);
  const b = await body(req);
  const incoming = Array.isArray(b.bets) ? b.bets : [];
  if (incoming.length > MAX_BETS + 200) throw new HttpError(413, 'Too many bets.');
  const valid = incoming.map(cleanBet).filter(Boolean);
  // Bets the server hasn't seen before are new saves. Edits, grades and deletes of known bets never count.
  const known = new Set();
  for (let i = 0; i < valid.length; i += 50) {
    const ids = valid.slice(i, i + 50).map(x => x.bet.id);
    const r = await db.prepare(`SELECT id FROM bets WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(u.id, ...ids).all();
    for (const row of r.results || []) known.add(row.id);
  }
  const fresh = valid.filter(x => !known.has(x.bet.id) && !x.bet.deleted);
  const rejected = [];
  if (fresh.length) {
    const row = await userRow(db, u.id);
    if (!isUnlimited(row)) {
      const start = await limitsStart(db);
      for (const x of fresh) {
        if (isLegacyBet(x.bet, start)) continue;               // saved in a browser before limits started
        if (!(await claimSave(db, env, u.id))) { rejected.push(x.bet.id); x.skip = true; }
      }
    }
  }
  const stmts = valid.filter(x => !x.skip).map(x => upsertBet(db, u.id, x));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  const rows = await db.prepare('SELECT data FROM bets WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').bind(u.id, MAX_BETS + 200).all();
  const bets = (rows.results || []).map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  return json(req, { bets, rejected, quota: await quota(db, env, await userRow(db, u.id)) });
}

function cleanBet(bet) {
  if (!bet || typeof bet !== 'object' || typeof bet.id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(bet.id)) return null;
  const updated = Number(bet.updated);
  if (!Number.isFinite(updated) || updated <= 0) return null;
  const data = JSON.stringify(bet);
  if (data.length > MAX_BET_BYTES) return null;
  return { bet, data, updated: Math.floor(updated) };
}
const upsertBet = (db, userId, x) => db.prepare(
  `INSERT INTO bets (user_id, id, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted
   WHERE excluded.updated_at > bets.updated_at`,
).bind(userId, x.bet.id, x.data, x.updated, x.bet.deleted ? 1 : 0);

// Save one new bet. This is where the free daily limit applies: 402 when today's saves are used up.
async function saveBet(req, db, env) {
  const u = await auth(req, db);
  const b = await body(req);
  const x = cleanBet(b.bet);
  if (!x || x.bet.deleted) throw new HttpError(400, "That bet couldn't be saved.");
  const exists = await db.prepare('SELECT 1 FROM bets WHERE user_id = ? AND id = ?').bind(u.id, x.bet.id).first();
  const row = await userRow(db, u.id);
  if (!exists && !isUnlimited(row)) {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM bets WHERE user_id = ?').bind(u.id).first();
    if ((n?.n || 0) >= MAX_BETS + 150) throw new HttpError(400, 'Your bet history is full. Delete some old bets first.');
    if (!(await claimSave(db, env, u.id))) {
      const q = await quota(db, env, row);
      return json(req, { error: `Free accounts can save ${q.limit} bets a day. Go Unlimited to save as many as you want.`, code: 'limit', quota: q }, 402);
    }
  }
  await upsertBet(db, u.id, x).run();
  return json(req, { ok: true, quota: await quota(db, env, row) });
}

// Profile settings. Right now that's "My books": the sportsbooks and exchanges the user has accounts with.
const BOOK_KEY_RE = /^[a-z0-9_]{2,30}$/;
const MAX_PREF_BOOKS = 40;
function cleanPrefs(p) {
  const books = Array.isArray(p?.books) ? [...new Set(p.books.filter(k => typeof k === 'string' && BOOK_KEY_RE.test(k)))].slice(0, MAX_PREF_BOOKS) : [];
  return { books };
}
async function getPrefs(req, db) {
  const u = await auth(req, db);
  const row = await db.prepare('SELECT data, updated_at FROM prefs WHERE user_id = ?').bind(u.id).first();
  let prefs = null;
  if (row) { try { prefs = cleanPrefs(JSON.parse(row.data)); } catch { prefs = null; } }
  return json(req, { prefs, updated_at: row?.updated_at || 0 });
}
// Newest `updated_at` wins, same as bets, so an old tab can't overwrite a newer choice.
async function putPrefs(req, db) {
  const u = await auth(req, db);
  const b = await body(req);
  const prefs = cleanPrefs(b.prefs);
  let updated = Math.floor(Number(b.updated_at));
  if (!Number.isFinite(updated) || updated <= 0) updated = Date.now();
  updated = Math.min(updated, Date.now() + 60_000);
  await db.prepare(
    `INSERT INTO prefs (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE excluded.updated_at > prefs.updated_at`,
  ).bind(u.id, JSON.stringify(prefs), updated).run();
  return getPrefs(req, db);
}

async function deleteAccount(req, db, env) {
  const u = await auth(req, db);
  const b = await body(req);
  const row = await db.prepare('SELECT pw, stripe_sub, stripe_status FROM users WHERE id = ?').bind(u.id).first();
  if (!row || !(await checkPassword(String(b.password ?? ''), row.pw))) throw new HttpError(401, 'Wrong password.');
  // Never leave a deleted account still being charged.
  if (row.stripe_sub && !['canceled', 'incomplete_expired'].includes(row.stripe_status)) {
    if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "We couldn't cancel your subscription right now. Email cory@screwvig.com and we'll take care of it.");
    try { await stripe(env, 'DELETE', `/v1/subscriptions/${encodeURIComponent(row.stripe_sub)}`); } catch (err) {
      if (err.status !== 404) { console.error('cancel on delete', err); throw new HttpError(502, "We couldn't cancel your subscription just now, so nothing was deleted. Please try again."); }
    }
  }
  await db.batch([
    db.prepare('DELETE FROM saves WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM redemptions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM bets WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM resets WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM alerts WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM prefs WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(u.id),
  ]);
  return json(req, { ok: true });
}

// ---------- membership: plans and the free daily limit ----------
const userRow = (db, id) => db.prepare('SELECT id, username, email, created_at, plan, plan_until, plan_source, plan_code, stripe_customer, stripe_sub, stripe_status FROM users WHERE id = ?').bind(id).first();
const isUnlimited = (row, now = Date.now()) => !!row && row.plan === 'unlimited' && (row.plan_until == null || row.plan_until > now);
const freeLimit = env => { const n = Number(env.FREE_SAVES_PER_DAY); return Number.isInteger(n) && n >= 0 ? n : FREE_SAVES_PER_DAY; };

// Calendar date and time in Central time.
const tzParts = (ms, tz = PLAN_TZ) => {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) o[p.type] = Number(p.value);
  return o;
};
const planDay = (ms = Date.now()) => { const p = tzParts(ms); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
// The next Central-time midnight after `ms`.
function nextMidnight(ms = Date.now()) {
  const p = tzParts(ms);
  let t = Date.UTC(p.year, p.month - 1, p.day + 1, 6);       // midnight CST is 06:00 UTC
  const q = tzParts(t);
  t -= (q.hour * 60 + q.minute) * 60e3;                      // 01:00 there means daylight time: step back
  return t;
}

let limitsStartCache = null;
async function limitsStart(db) {
  if (limitsStartCache) return limitsStartCache;
  const row = await db.prepare("SELECT v FROM config WHERE k = 'limits_start'").first();
  return (limitsStartCache = Number(row?.v) || Date.now());
}
// A bet saved in a browser (signed out) before limits started merges into an account for free. Lines only go
// about two weeks out, so a bet that claims to be that old can't have legs much later than that.
function isLegacyBet(bet, start) {
  const created = Date.parse(bet.created);
  if (!Number.isFinite(created) || created >= start) return false;
  return (Array.isArray(bet.legs) ? bet.legs : []).every(l => !l?.commence || Date.parse(l.commence) < start + 15 * 864e5);
}

// Use one of today's free saves. False when they're used up. The check and the +1 happen in one statement.
async function claimSave(db, env, userId) {
  const max = freeLimit(env);
  if (max <= 0) return false;
  const r = await db.prepare('INSERT INTO saves (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1 WHERE n < ?')
    .bind(userId, planDay(), max).run();
  return (r.meta?.changes || 0) > 0;
}

async function quota(db, env, row) {
  if (isUnlimited(row)) return { unlimited: true };
  const r = await db.prepare('SELECT n FROM saves WHERE user_id = ? AND day = ?').bind(row.id, planDay()).first();
  const limit = freeLimit(env), used = Math.min(r?.n || 0, limit);
  return { unlimited: false, limit, used, left: limit - used, resets_at: nextMidnight() };
}

async function isAdmin(db, env, row) {
  if (!row?.email) return false;
  const emails = String(env.ADMIN_EMAILS || ADMIN_EMAILS).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!emails.includes(row.email)) return false;
  // The first account with an admin email to ask is pinned, so an email swap later can't hand over admin.
  await db.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('admin_ids', ?)").bind(String(row.id)).run();
  const pinned = await db.prepare("SELECT v FROM config WHERE k = 'admin_ids'").first();
  return String(pinned?.v || '').split(',').includes(String(row.id));
}

const billingReady = env => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_MONTHLY);

async function membership(db, env, row) {
  const unlimited = isUnlimited(row);
  return {
    plan: {
      name: unlimited ? 'unlimited' : 'free',
      source: unlimited ? row.plan_source || null : null,
      until: unlimited ? row.plan_until ?? null : null,
      stripe_status: row?.stripe_status || null,
      paid_through: unlimited && row.plan_source === 'stripe' && row.plan_until ? row.plan_until - STRIPE_GRACE_DAYS * 864e5 : null,
      renews: unlimited && row.plan_source === 'stripe' && ['active', 'trialing'].includes(row.stripe_status),
      manage: !!(row?.stripe_sub && env.STRIPE_SECRET_KEY),
    },
    quota: await quota(db, env, row),
    billing: { ready: billingReady(env), annual: !!env.STRIPE_PRICE_ANNUAL },
    admin: await isAdmin(db, env, row),
  };
}

async function getPlan(req, db, env) {
  const u = await auth(req, db);
  return json(req, await membership(db, env, await userRow(db, u.id)));
}

// ---------- secret codes ----------
const normCode = c => String(c ?? '').toUpperCase().replace(/[\s_]+/g, '').replace(/[–—]/g, '-');
const codeHash = c => sha256('code:' + normCode(c).replace(/-/g, ''));   // dashes are optional when typing
const codeHint = c => { const v = normCode(c); return v.length <= 6 ? `${v[0]}…` : `${v.slice(0, 3)}…${v.slice(-2)}`; };
function randomCode() {
  const pick = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `VIG-${pick(4)}-${pick(4)}`;
}

async function redeemCode(req, db, env) {
  const u = await auth(req, db);
  const b = await body(req);
  const code = normCode(b.code);
  if (!CODE_RE.test(code)) throw new HttpError(400, "That doesn't look like a code. Check it and try again.");
  await limit(db, 'redeem:' + u.id, 5, 3600e3);
  await limit(db, 'redeem:' + await ipKey(req), 20, 3600e3);
  const now = Date.now();
  const c = await db.prepare('SELECT * FROM codes WHERE code_hash = ?').bind(await codeHash(code)).first();
  if (!c || c.revoked) throw new HttpError(404, "That code isn't valid.");
  if (c.expires_at && c.expires_at < now) throw new HttpError(410, 'That code has expired.');
  if (c.max_uses != null && c.uses >= c.max_uses) throw new HttpError(410, 'That code has already been used up.');
  if (await db.prepare('SELECT 1 FROM redemptions WHERE code_id = ? AND user_id = ?').bind(c.id, u.id).first()) throw new HttpError(409, "You've already used this code.");
  const row = await userRow(db, u.id);
  if (isUnlimited(row) && row.plan_until == null && row.plan_source !== 'stripe') throw new HttpError(409, 'You already have Unlimited with no end date.');
  if (isUnlimited(row) && row.plan_source === 'stripe' && ['active', 'trialing', 'past_due', 'canceling'].includes(row.stripe_status)) {
    throw new HttpError(409, "You're already paying for Unlimited. Cancel it under Manage billing first, then redeem the code.");
  }
  const took = await db.prepare('UPDATE codes SET uses = uses + 1 WHERE id = ? AND revoked = 0 AND (max_uses IS NULL OR uses < max_uses)').bind(c.id).run();
  if (!took.meta?.changes) throw new HttpError(410, 'That code has already been used up.');
  const base = isUnlimited(row) && row.plan_until ? Math.max(row.plan_until, now) : now;   // time-limited codes stack
  const until = c.grant_days ? base + c.grant_days * 864e5 : null;
  await db.batch([
    db.prepare('INSERT INTO redemptions (code_id, user_id, at) VALUES (?, ?, ?)').bind(c.id, u.id, now),
    db.prepare("UPDATE users SET plan = 'unlimited', plan_until = ?, plan_source = 'code', plan_code = ? WHERE id = ?").bind(until, c.id, u.id),
  ]);
  return json(req, { ok: true, ...(await membership(db, env, await userRow(db, u.id))) });
}

// ---------- admin (codes, grants, numbers) ----------
async function adminAuth(req, db, env) {
  const u = await auth(req, db);
  const row = await userRow(db, u.id);
  if (!(await isAdmin(db, env, row))) throw new HttpError(403, 'Admins only.');
  return row;
}

async function adminOverview(req, db, env) {
  await adminAuth(req, db, env);
  const now = Date.now();
  const users = await db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN plan = 'unlimited' AND (plan_until IS NULL OR plan_until > ?) THEN 1 ELSE 0 END) AS unlimited,
      SUM(CASE WHEN plan = 'unlimited' AND (plan_until IS NULL OR plan_until > ?) AND plan_source = 'stripe' THEN 1 ELSE 0 END) AS paying,
      SUM(CASE WHEN plan = 'unlimited' AND (plan_until IS NULL OR plan_until > ?) AND plan_source = 'code' THEN 1 ELSE 0 END) AS by_code,
      SUM(CASE WHEN plan = 'unlimited' AND (plan_until IS NULL OR plan_until > ?) AND plan_source = 'admin' THEN 1 ELSE 0 END) AS by_admin,
      SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS new_7d FROM users`).bind(now, now, now, now, now - 7 * 864e5).first();
  const saves = await db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM saves WHERE day = ?').bind(planDay()).first();
  const codes = await db.prepare('SELECT id, hint, label, max_uses, uses, grant_days, expires_at, revoked, created_at FROM codes ORDER BY revoked, created_at DESC LIMIT 300').all();
  const recent = await db.prepare(`SELECT r.at, u.username, c.label, c.hint FROM redemptions r JOIN users u ON u.id = r.user_id JOIN codes c ON c.id = r.code_id ORDER BY r.at DESC LIMIT 50`).all();
  const members = await db.prepare(`SELECT username, email, plan_source, plan_until, stripe_status, created_at FROM users
      WHERE plan = 'unlimited' AND (plan_until IS NULL OR plan_until > ?) ORDER BY created_at DESC LIMIT 300`).bind(now).all();
  return json(req, {
    users: { total: users?.total || 0, unlimited: users?.unlimited || 0, paying: users?.paying || 0, by_code: users?.by_code || 0, by_admin: users?.by_admin || 0, new_7d: users?.new_7d || 0 },
    saves_today: saves?.n || 0, free_limit: freeLimit(env), billing_ready: billingReady(env),
    codes: codes.results || [], redemptions: recent.results || [], members: members.results || [],
  });
}

// Every account, newest first, with a search box (username or email). 100 per page.
async function adminUsers(req, db, env) {
  await adminAuth(req, db, env);
  const url = new URL(req.url);
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '').slice(0, 80);
  const page = Math.max(0, Math.min(1000, Number(url.searchParams.get('page')) || 0));
  const per = 100;
  const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`;
  const where = q ? "WHERE u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'" : '';
  const args = q ? [like, like] : [];
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...args).first();
  const rows = await db.prepare(`SELECT u.id, u.username, u.email, u.created_at, u.plan, u.plan_until, u.plan_source, u.stripe_status,
      (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id AND b.deleted = 0) AS bets,
      (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login,
      (SELECT n FROM saves v WHERE v.user_id = u.id AND v.day = ?) AS saves_today
    FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).bind(planDay(), ...args, per, page * per).all();
  const now = Date.now();
  const users = (rows.results || []).map(r => ({
    username: r.username, email: r.email, created_at: r.created_at, bets: r.bets || 0, last_login: r.last_login || null,
    saves_today: r.saves_today || 0, unlimited: isUnlimited(r, now), plan_source: isUnlimited(r, now) ? r.plan_source : null,
    plan_until: isUnlimited(r, now) ? r.plan_until : null, stripe_status: r.stripe_status || null,
  }));
  return json(req, { total: total?.n || 0, page, per, users });
}

const posInt = (v, max) => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `Use a whole number from 1 to ${max}.`); return n; };

async function adminCreateCode(req, db, env) {
  await adminAuth(req, db, env);
  const b = await body(req);
  const code = b.code ? normCode(b.code) : randomCode();
  if (!CODE_RE.test(code)) throw new HttpError(400, 'Codes are 4–32 letters, numbers or dashes.');
  const label = oneLine(b.label, 80);
  if (!label) throw new HttpError(400, "Add a note so you remember who it's for.");
  const maxUses = posInt(b.max_uses, 100000);
  const days = posInt(b.grant_days, 3650);
  let expires = null;
  if (b.expires) {
    expires = Date.parse(`${b.expires}T23:59:59-06:00`);   // end of that day, Central (close enough across DST)
    if (!Number.isFinite(expires) || expires < Date.now()) throw new HttpError(400, 'Pick a last day that is in the future.');
  }
  const h = await codeHash(code);
  if (await db.prepare('SELECT 1 FROM codes WHERE code_hash = ?').bind(h).first()) throw new HttpError(409, 'That code already exists. Pick another.');
  await db.prepare('INSERT INTO codes (code_hash, hint, label, max_uses, grant_days, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(h, codeHint(code), label, maxUses, days, expires, Date.now()).run();
  return json(req, { ok: true, code });   // the only time the full code is shown
}

async function adminRevokeCode(req, db, env) {
  await adminAuth(req, db, env);
  const b = await body(req);
  const id = Number(b.id) || 0;
  const r = await db.prepare('UPDATE codes SET revoked = 1 WHERE id = ?').bind(id).run();
  if (!r.meta?.changes) throw new HttpError(404, 'No such code.');
  let dropped = 0;
  if (b.downgrade) {
    const d = await db.prepare("UPDATE users SET plan = 'free', plan_until = NULL, plan_source = NULL, plan_code = NULL WHERE plan_source = 'code' AND plan_code = ?").bind(id).run();
    dropped = d.meta?.changes || 0;
  }
  return json(req, { ok: true, dropped });
}

async function adminGrant(req, db, env) {
  await adminAuth(req, db, env);
  const b = await body(req);
  const who = String(b.username ?? '').trim().toLowerCase().replace(/^@/, '');
  const u = await db.prepare(`SELECT id, username, plan, plan_until, plan_source, stripe_status FROM users WHERE ${who.includes('@') ? 'email' : 'username'} = ?`).bind(who).first();
  if (!u) throw new HttpError(404, 'No account with that username or email.');
  const paying = u.plan_source === 'stripe' && ['active', 'trialing', 'past_due', 'canceling'].includes(u.stripe_status);
  if (b.remove) {
    if (paying) throw new HttpError(409, `@${u.username} pays through Stripe. Cancel it in your Stripe dashboard instead.`);
    await db.prepare("UPDATE users SET plan = 'free', plan_until = NULL, plan_source = NULL, plan_code = NULL WHERE id = ?").bind(u.id).run();
    return json(req, { ok: true, username: u.username, plan: 'free' });
  }
  if (paying) throw new HttpError(409, `@${u.username} already pays for Unlimited.`);
  const days = posInt(b.days, 3650);
  const until = days ? Date.now() + days * 864e5 : null;
  await db.prepare("UPDATE users SET plan = 'unlimited', plan_until = ?, plan_source = 'admin', plan_code = NULL WHERE id = ?").bind(until, u.id).run();
  return json(req, { ok: true, username: u.username, plan: 'unlimited', until });
}

// ---------- Stripe billing ----------
// Stripe's API takes form-encoded bodies with bracketed keys: line_items[0][price]=...
function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out); else out.append(key, String(v));
  }
  return out;
}
async function stripe(env, method, path, params) {
  const res = await fetch((env.STRIPE_API || 'https://api.stripe.com') + path + (method === 'GET' && params ? `?${formEncode(params)}` : ''), {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' && params ? formEncode(params).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`Stripe ${res.status}: ${data?.error?.message || ''}`); e.status = res.status; throw e; }
  return data;
}

async function checkout(req, db, env) {
  const u = await auth(req, db);
  if (!billingReady(env)) throw new HttpError(503, "Payments aren't switched on yet. Check back soon.");
  const b = await body(req);
  const annual = b.interval === 'year' && env.STRIPE_PRICE_ANNUAL;
  const row = await userRow(db, u.id);
  if (isUnlimited(row) && (row.plan_until == null || row.plan_source === 'stripe')) throw new HttpError(409, 'You already have Unlimited.');
  await limit(db, 'checkout:' + u.id, 20, 3600e3);
  let customer = row.stripe_customer;
  if (!customer) {
    const c = await stripe(env, 'POST', '/v1/customers', { email: row.email || undefined, metadata: { user_id: u.id, username: u.username } });
    customer = c.id;
    await db.prepare('UPDATE users SET stripe_customer = ? WHERE id = ?').bind(customer, u.id).run();
  }
  const site = siteUrl(env);
  const s = await stripe(env, 'POST', '/v1/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: u.id,
    line_items: { 0: { price: annual ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY, quantity: 1 } },
    subscription_data: { metadata: { user_id: u.id } },
    allow_promotion_codes: 'true',
    success_url: `${site}#upgraded`, cancel_url: `${site}#bets`,
  });
  return json(req, { url: s.url });
}

async function billingPortal(req, db, env) {
  const u = await auth(req, db);
  const row = await userRow(db, u.id);
  if (!env.STRIPE_SECRET_KEY || !row.stripe_customer) throw new HttpError(400, 'There is no billing on this account.');
  const s = await stripe(env, 'POST', '/v1/billing_portal/sessions', { customer: row.stripe_customer, return_url: `${siteUrl(env)}#bets` });
  return json(req, { url: s.url });
}

// Stripe signs each webhook: header "t=<unix>,v1=<hex hmac of `${t}.${body}`>".
async function verifyStripe(raw, header, secret, now = Date.now()) {
  const t = /(?:^|,)t=(\d+)/.exec(header || '')?.[1];
  const sigs = [...String(header || '').matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].map(m => m[1]);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const want = hex(await hmac(enc.encode(secret), enc.encode(`${t}.${raw}`)));
  return sigs.some(s => { let d = 0; for (let i = 0; i < 64; i++) d |= s.charCodeAt(i) ^ want.charCodeAt(i); return d === 0; });
}

// Put a subscription's state on its account. Always re-reads the subscription from Stripe, so events that
// arrive out of order or twice can't leave the account wrong.
async function applySubscription(db, env, subId, hintUserId) {
  const sub = await stripe(env, 'GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
  let row = await db.prepare('SELECT id, plan_source FROM users WHERE stripe_customer = ?').bind(sub.customer).first();
  const uid = row?.id || Number(sub.metadata?.user_id || hintUserId) || 0;
  if (!row && uid) {
    row = await db.prepare('SELECT id, plan_source FROM users WHERE id = ?').bind(uid).first();
    if (row) await db.prepare('UPDATE users SET stripe_customer = ? WHERE id = ?').bind(sub.customer, row.id).run();
  }
  if (!row) { console.error('stripe: no account for', sub.customer); return; }
  const end = (sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? 0) * 1000;
  const live = ['active', 'trialing', 'past_due'].includes(sub.status);
  // 'canceling' = still paid up, but set to end at the period end (so it isn't shown as renewing).
  const status = live && (sub.cancel_at_period_end || sub.cancel_at) ? 'canceling' : sub.status;
  if (live) {
    await db.prepare("UPDATE users SET plan = 'unlimited', plan_until = ?, plan_source = 'stripe', plan_code = NULL, stripe_sub = ?, stripe_status = ? WHERE id = ?")
      .bind(end ? end + STRIPE_GRACE_DAYS * 864e5 : null, sub.id, status, row.id).run();
  } else if (row.plan_source === 'stripe') {
    await db.prepare("UPDATE users SET plan = 'free', plan_until = NULL, plan_source = NULL, stripe_sub = ?, stripe_status = ? WHERE id = ?").bind(sub.id, sub.status, row.id).run();
  } else {
    await db.prepare('UPDATE users SET stripe_sub = ?, stripe_status = ? WHERE id = ?').bind(sub.id, sub.status, row.id).run();
  }
}

async function stripeWebhook(req, db, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Billing is not set up.');
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, 'Too much data.');
  if (!(await verifyStripe(raw, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) throw new HttpError(400, 'Bad signature.');
  let ev;
  try { ev = JSON.parse(raw); } catch { throw new HttpError(400, 'Bad request.'); }
  const o = ev.data?.object || {};
  if (ev.type === 'checkout.session.completed' && o.mode === 'subscription' && o.subscription) {
    await applySubscription(db, env, o.subscription, o.client_reference_id);
  } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(ev.type) && o.id) {
    await applySubscription(db, env, o.id, o.metadata?.user_id);
  } else if (/^invoice\.(paid|payment_failed)$/.test(ev.type)) {
    const subId = o.subscription || o.parent?.subscription_details?.subscription;
    if (subId) await applySubscription(db, env, subId);
  }
  return json(req, { received: true });
}

// ---------- web push ----------
// <push-crypto>  (tests extract this block and check it against the web-push library)
const concatBytes = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// RFC 8291 message encryption (aes128gcm, one record).
async function encryptPush(payload, p256dh, authSecret, salt = crypto.getRandomValues(new Uint8Array(16)), asKeys = null) {
  const te = new TextEncoder();
  const uaPub = fromB64url(p256dh), auth = fromB64url(authSecret);
  const as = asKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concatBytes(te.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concatBytes(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concatBytes(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concatBytes(te.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  header.set(asPub, 21);
  return concatBytes(header, ct);
}
// RFC 8292 VAPID JWT (ES256). WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
async function vapidJwt(privateKey, aud, sub, exp) {
  const part = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp, sub })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}
// </push-crypto>

let vapidCache = null;
async function vapidKeys(db) {
  if (vapidCache) return vapidCache;
  let row = await db.prepare("SELECT v FROM config WHERE k = 'vapid'").first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const v = JSON.stringify({ jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64url(await crypto.subtle.exportKey('raw', kp.publicKey)) });
    await db.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('vapid', ?)").bind(v).run();   // first writer wins
    row = await db.prepare("SELECT v FROM config WHERE k = 'vapid'").first();
  }
  const { jwk, pub } = JSON.parse(row.v);
  vapidCache = { key: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']), pub, jwts: new Map() };
  return vapidCache;
}
async function vapidHeader(db, endpoint, env) {
  const v = await vapidKeys(db);
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  let hit = v.jwts.get(aud);
  if (!hit || hit.exp - 600 < now) {
    hit = { exp: now + 12 * 3600 };
    hit.jwt = await vapidJwt(v.key, aud, env.VAPID_SUBJECT || 'https://screwvig.com', hit.exp);
    v.jwts.set(aud, hit);
  }
  return `vapid t=${hit.jwt}, k=${v.pub}`;
}

// Only real browser push services (keeps the worker from being pointed at arbitrary URLs).
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)\//;
const okEndpoint = (u, env) => PUSH_HOSTS.test(u) || (!!env.PUSH_TEST_ORIGIN && u.startsWith(env.PUSH_TEST_ORIGIN + '/'));

async function sendPush(db, env, sub, payload) {
  const body = await encryptPush(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(db, sub.endpoint, env), TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (res.status === 404 || res.status === 410) {               // the browser dropped this subscription
    await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
    return false;
  }
  if (!res.ok) { console.error('push failed', res.status, (await res.text()).slice(0, 200)); return false; }
  return true;
}
async function pushToUser(db, env, userId, payload) {
  const rows = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').bind(userId).all();
  let sent = 0;
  for (const s of rows.results || []) {
    try { if (await sendPush(db, env, s, payload)) sent++; } catch (err) { console.error('push error', err); }
  }
  return sent;
}

async function pushKey(req, db) {
  return json(req, { key: (await vapidKeys(db)).pub });
}
async function pushSubscribe(req, db, env) {
  const u = await auth(req, db);
  const b = await body(req);
  const endpoint = String(b.endpoint ?? '');
  const p256dh = String(b.keys?.p256dh ?? ''), key = String(b.keys?.auth ?? '');
  if (endpoint.length > 1000 || !okEndpoint(endpoint, env)) throw new HttpError(400, "This browser's push service isn't supported.");
  if (!/^[A-Za-z0-9_-]{86,88}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,24}={0,2}$/.test(key)) throw new HttpError(400, 'Bad push keys.');
  await db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).bind(u.id, endpoint, p256dh, key, Date.now()).run();
  // Keep the newest 10 devices per account.
  await db.prepare('DELETE FROM push_subs WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10)').bind(u.id, u.id).run();
  return json(req, { ok: true });
}
async function pushUnsubscribe(req, db) {
  const u = await auth(req, db);
  const b = await body(req);
  await db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint ?? ''), u.id).run();
  return json(req, { ok: true });
}
async function pushTest(req, db, env) {
  const u = await auth(req, db);
  await limit(db, 'pushtest:' + u.id, 10, 3600e3);
  const sent = await pushToUser(db, env, u.id, { title: 'fck the vig', body: 'Push alerts are working on this device.', url: './#bets', tag: 'ftv-test' });
  return json(req, { sent });
}

// ---------- line-move alerts ----------
const str = (v, max) => (typeof v === 'string' && v.length && v.length <= max ? v : null);
function alertRow(r) {
  const parse = t => { try { return JSON.parse(t); } catch { return null; } };
  return { id: r.id, created_at: r.created_at, spec: parse(r.spec), mode: r.mode, target: r.target, base_price: r.base_price,
    base_point: r.base_point, books: parse(r.books), channels: String(r.channels || '').split(',').filter(Boolean), status: r.status,
    sent_at: r.sent_at, message: r.message };
}

async function listAlerts(req, db) {
  const u = await auth(req, db);
  const rows = await db.prepare(`SELECT * FROM alerts WHERE user_id = ? ORDER BY (status = 'active') DESC, created_at DESC LIMIT 60`).bind(u.id).all();
  return json(req, { alerts: (rows.results || []).map(alertRow) });
}

async function createAlert(req, db) {
  const u = await auth(req, db);
  const b = await body(req);
  const sp = b.spec || {};
  const point = sp.point == null ? null : Number(sp.point);
  const commence = Date.parse(sp.commence);
  const spec = {
    sport: str(sp.sport, 60), eventId: str(sp.eventId, 100), home: str(sp.home, 100), away: str(sp.away, 100),
    commence: str(sp.commence, 40), market: /^[a-z0-9_]{2,60}$/.test(sp.market || '') ? sp.market : null, name: str(sp.name, 100),
    desc: sp.desc == null ? null : str(sp.desc, 100), point: Number.isFinite(point) ? point : null, label: str(sp.label, 200),
  };
  if (!spec.sport || !spec.eventId || !spec.home || !spec.away || !spec.market || !spec.name || !spec.label || !Number.isFinite(commence)) throw new HttpError(400, 'That bet is missing details. Try again from the board.');
  if (sp.desc != null && !spec.desc) throw new HttpError(400, 'Bad player name.');
  if (commence < Date.now()) throw new HttpError(400, 'That game has already started.');
  const mode = b.mode === 'move' ? 'move' : b.mode === 'target' ? 'target' : null;
  if (!mode) throw new HttpError(400, 'Pick when to alert you.');
  const am = v => (v == null ? null : Number.isInteger(Number(v)) && Math.abs(Number(v)) >= 100 && Math.abs(Number(v)) <= 100000 ? Number(v) : NaN);
  const target = mode === 'target' ? am(b.target) : null;
  if (mode === 'target' && !Number.isFinite(target)) throw new HttpError(400, 'Enter target odds like -105 or +150.');
  const basePrice = am(b.base_price);
  if (Number.isNaN(basePrice)) throw new HttpError(400, 'Bad price.');
  const bp = b.base_point == null ? null : Number(b.base_point);
  const books = (Array.isArray(b.books) ? b.books : []).filter(x => typeof x === 'string' && /^[a-z0-9_]{2,30}$/.test(x)).slice(0, 40);
  const channels = [...new Set((Array.isArray(b.channels) ? b.channels : []).filter(c => c === 'push' || c === 'email'))];
  if (!channels.length) throw new HttpError(400, 'Pick push, email or both.');
  if (channels.includes('email')) {
    const e = await db.prepare('SELECT email FROM users WHERE id = ?').bind(u.id).first();
    if (!e?.email) throw new HttpError(400, 'Add an email to your account to get email alerts.');
  }
  await limit(db, 'alertnew:' + u.id, 60, 3600e3);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND status = 'active'").bind(u.id).first();
  // Replace an identical active alert instead of stacking duplicates.
  const specJson = JSON.stringify(spec);
  const dup = await db.prepare("SELECT id FROM alerts WHERE user_id = ? AND status = 'active' AND spec = ? AND mode = ?").bind(u.id, specJson, mode).first();
  if (!dup && (n?.n || 0) >= MAX_ALERTS) throw new HttpError(400, `You can have ${MAX_ALERTS} alerts running at once. Delete one first.`);
  const vals = [mode, target, basePrice, Number.isFinite(bp) ? bp : null, JSON.stringify(books), channels.join(','), commence];
  let id;
  if (dup) {
    await db.prepare('UPDATE alerts SET mode = ?, target = ?, base_price = ?, base_point = ?, books = ?, channels = ?, commence = ? WHERE id = ?').bind(...vals, dup.id).run();
    id = dup.id;
  } else {
    const r = await db.prepare('INSERT INTO alerts (mode, target, base_price, base_point, books, channels, commence, user_id, created_at, spec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(...vals, u.id, Date.now(), specJson).run();
    id = r.meta.last_row_id;
  }
  const row = await db.prepare('SELECT * FROM alerts WHERE id = ?').bind(id).first();
  return json(req, { alert: alertRow(row) });
}

async function deleteAlert(req, db) {
  const u = await auth(req, db);
  const b = await body(req);
  await db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?').bind(Number(b.id) || 0, u.id).run();
  return json(req, { ok: true });
}

// GitHub Actions OIDC: only workflows running on this repo's main branch can mint a token GitHub signs with these claims.
let jwks = null;
async function githubKey(kid, env) {
  const url = env.OIDC_JWKS_URL || 'https://token.actions.githubusercontent.com/.well-known/jwks';
  if (!jwks || jwks.url !== url || Date.now() - jwks.at > 3600e3 || !jwks.keys.some(k => k.kid === kid)) {
    const r = await fetch(url);
    if (!r.ok) throw new HttpError(503, "Couldn't check the GitHub token.");
    jwks = { url, at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = jwks.keys.find(k => k.kid === kid);
  if (!jwk) throw new HttpError(401, 'Unknown token key.');
  return crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}
async function actionAuth(req, env) {
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'GitHub Actions token required.');
  let head, claims;
  try {
    const td = new TextDecoder();
    head = JSON.parse(td.decode(fromB64url(m[1])));
    claims = JSON.parse(td.decode(fromB64url(m[2])));
  } catch { throw new HttpError(401, 'Bad token.'); }
  if (head.alg !== 'RS256' || typeof head.kid !== 'string') throw new HttpError(401, 'Bad token.');
  const key = await githubKey(head.kid, env);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(m[3]), enc.encode(`${m[1]}.${m[2]}`));
  const now = Date.now() / 1000;
  const iss = env.OIDC_ISSUER || 'https://token.actions.githubusercontent.com';
  if (!ok || claims.iss !== iss || claims.aud !== OIDC_AUDIENCE || claims.repository !== (env.GITHUB_REPO || GITHUB_REPO)
    || claims.ref !== 'refs/heads/main' || !(claims.exp > now) || (claims.nbf != null && claims.nbf > now + 60)) {
    throw new HttpError(403, 'Not allowed.');
  }
  return claims;
}

async function activeAlerts(req, db, env) {
  await actionAuth(req, env);
  const rows = await db.prepare("SELECT id, spec, mode, target, base_price, base_point, books, commence FROM alerts WHERE status = 'active' ORDER BY id LIMIT 5000").all();
  return json(req, { alerts: (rows.results || []).map(r => ({ ...alertRow(r), commence: r.commence })) });
}

async function fireAlerts(req, db, env) {
  await actionAuth(req, env);
  const b = await body(req);
  const fired = (Array.isArray(b.fired) ? b.fired : []).slice(0, 200);
  const expired = (Array.isArray(b.expired) ? b.expired : []).map(Number).filter(Number.isInteger).slice(0, 1000);
  const site = (env.SITE_URL || 'https://screwvig.com').replace(/\/$/, '');
  const out = { sent: 0, pushes: 0, emails: 0, expired: 0 };
  for (const f of fired) {
    const id = Number(f?.id);
    const message = str(f?.message, 400);
    if (!Number.isInteger(id) || !message) continue;
    const row = await db.prepare("SELECT a.*, u.email FROM alerts a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.status = 'active'").bind(id).first();
    if (!row) continue;
    const claimed = await db.prepare("UPDATE alerts SET status = 'sent', sent_at = ?, message = ? WHERE id = ? AND status = 'active'").bind(Date.now(), message, id).run();
    if (!claimed.meta?.changes) continue;      // another run already sent it
    out.sent++;
    const a = alertRow(row);
    const title = `Line move: ${a.spec?.label || 'your bet'}`;
    if (a.channels.includes('push')) out.pushes += await pushToUser(db, env, row.user_id, { title, body: message, url: './#bets', tag: `ftv-alert-${id}` });
    if (a.channels.includes('email') && row.email && mailerReady(env)) {
      try {
        await limit(db, `alertmail:${row.user_id}:${new Date().toISOString().slice(0, 10)}`, ALERT_MAIL_PER_USER_DAY, 864e5);
        await limit(db, `alertmail:${new Date().toISOString().slice(0, 10)}`, ALERT_MAIL_PER_DAY, 864e5);
        const game = a.spec ? `${a.spec.away} @ ${a.spec.home}` : '';
        await sendMail(env, {
          to: row.email, subject: title,
          text: `${message}\n${game}\n\nCompare every book: ${site}/\nManage your alerts: ${site}/#bets\n\nOdds move fast. Check the price in the app before you bet.\n`,
          html: `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#14062e">
<p style="font-size:18px;font-weight:700;margin:0 0 6px">${escHtml(message)}</p><p style="color:#555;margin:0 0 16px">${escHtml(game)}</p>
<p><a href="${site}/" style="display:inline-block;background:#9b74ff;color:#14062e;font-weight:700;padding:12px 20px;border-radius:12px;text-decoration:none">Compare every book</a></p>
<p style="font-size:14px;color:#555">Odds move fast. Check the price in the app before you bet. <a href="${site}/#bets">Manage your alerts</a>.</p></div>`,
        });
        out.emails++;
      } catch (err) { console.error('alert email skipped', err.message || err); }
    }
  }
  if (expired.length) {
    for (let i = 0; i < expired.length; i += 50) {
      const ids = expired.slice(i, i + 50);
      const r = await db.prepare(`UPDATE alerts SET status = 'expired' WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
      out.expired += r.meta?.changes || 0;
    }
  }
  await db.prepare("DELETE FROM alerts WHERE status != 'active' AND created_at < ?").bind(Date.now() - 30 * 864e5).run();
  return json(req, out);
}

// ---------- shared bets with their own link preview ----------
const SHARE_ID_RE = /^[A-Za-z0-9]{8,12}$/;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const shareId = () => [...crypto.getRandomValues(new Uint8Array(10))].map(b => B62[b % 62]).join('');
const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const siteUrl = env => (env.SITE_URL || 'https://screwvig.com').replace(/\/$/, '') + '/';

// Same packed format the site uses in its #p= links: [eventId, market, name, point, desc].
function cleanShareLegs(legs) {
  if (!Array.isArray(legs) || !legs.length || legs.length > SHARE_MAX_LEGS) return null;
  const out = [];
  for (const l of legs) {
    if (!Array.isArray(l) || l.length < 3 || l.length > 5) return null;
    const [eventId, market, name, point = null, desc = null] = l;
    if (!str(eventId, 100) || !/^[a-z0-9_]{1,60}$/.test(market) || !str(name, 120)) return null;
    if (point !== null && !(typeof point === 'number' && Number.isFinite(point))) return null;
    if (desc !== null && !str(desc, 120)) return null;
    out.push([eventId, market, name, point, desc]);
  }
  return out;
}
function imgBytes(b64s, mime) {
  if (typeof b64s !== 'string' || !b64s.length || b64s.length > Math.ceil(SHARE_MAX_IMG * 4 / 3) + 4) return null;
  let bytes;
  try { bytes = unb64(b64s); } catch { return null; }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mime === 'image/jpeg' ? !jpeg : mime === 'image/png' ? !png : true) return null;
  return bytes.length <= SHARE_MAX_IMG ? bytes : null;
}

async function createShare(req, db) {
  await limit(db, 'share:' + await ipKey(req), 40, 3600e3);
  await limit(db, 'share:all', 1500, 864e5);
  const b = await body(req);
  const legs = cleanShareLegs(b.legs);
  if (!legs) throw new HttpError(400, "That bet can't be shared.");
  const stake = typeof b.stake === 'number' && b.stake > 0 && b.stake <= 1e6 ? Math.round(b.stake * 100) / 100 : null;
  const title = oneLine(b.title, 140) || 'A bet on fck the vig';
  const descr = oneLine(b.desc, 300);
  const mime = b.mime === 'image/png' ? 'image/png' : 'image/jpeg';
  const img = b.img == null ? null : imgBytes(b.img, mime);
  if (b.img != null && !img) throw new HttpError(400, "That preview picture didn't come through.");
  const id = shareId();
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO shares (id, legs, stake, title, descr, img, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, JSON.stringify(legs), stake, title, descr, img ? b.img : null, img ? mime : null, now),
    // Keep the table small: pictures go after SHARE_IMG_DAYS or once there are more than SHARE_MAX_IMGS of them.
    db.prepare('UPDATE shares SET img = NULL, mime = NULL WHERE img IS NOT NULL AND (created_at < ? OR id IN (SELECT id FROM shares WHERE img IS NOT NULL ORDER BY created_at DESC LIMIT -1 OFFSET ?))')
      .bind(now - SHARE_IMG_DAYS * 864e5, SHARE_MAX_IMGS),
    db.prepare('DELETE FROM shares WHERE created_at < ?').bind(now - SHARE_DAYS * 864e5),
  ]);
  return json(req, { id, url: `${new URL(req.url).origin}/s/${id}` });
}

// Link-preview fetchers (iMessage sends "facebookexternalhit ... Twitterbot"). They get the preview tags with no
// redirect; people get the same page plus an instant redirect to the site with the bet loaded.
const PREVIEW_BOT = /bot\b|crawler|spider|facebookexternalhit|facebot|twitterbot|slackbot|discordbot|whatsapp|telegrambot|linkedinbot|pinterest|embedly|iframely|redditbot|applebot|skypeuripreview|google-pagerenderer|vkshare|snapchat|bitlybot|mastodon|preview/i;

async function sharePage(req, db, env, id) {
  const site = siteUrl(env);
  const row = SHARE_ID_RE.test(id) ? await db.prepare('SELECT id, legs, stake, title, descr, mime, created_at FROM shares WHERE id = ?').bind(id).first() : null;
  if (!row) return Response.redirect(site, 302);
  const target = `${site}#p=${b64url(enc.encode(row.legs))}${row.stake > 0 ? `&s=${row.stake}` : ''}`;
  const origin = new URL(req.url).origin;
  const image = row.mime ? `${origin}/s/${row.id}.${row.mime === 'image/png' ? 'png' : 'jpg'}` : `${site}og.png`;
  const bot = PREVIEW_BOT.test(req.headers.get('User-Agent') || '');
  const t = escHtml(row.title), d = escHtml(row.descr), u = escHtml(`${origin}/s/${row.id}`), img = escHtml(image), go = escHtml(target);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="fck the vig">
<meta property="og:url" content="${u}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${img}">
<meta property="og:image:secure_url" content="${img}">
<meta property="og:image:type" content="${row.mime || 'image/png'}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
<meta name="theme-color" content="#110a24">
${bot ? '' : `<meta http-equiv="refresh" content="0;url=${go}">\n<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>`}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#110a24;color:#f6f3ff;font:600 17px system-ui,sans-serif;text-align:center;padding:16px}a{color:#9b74ff}</style>
</head><body><p>${t}<br><a href="${go}">Open it on fck the vig</a></p></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}

async function shareImage(req, db, env, id, ext) {
  const row = SHARE_ID_RE.test(id) ? await db.prepare('SELECT img, mime FROM shares WHERE id = ?').bind(id).first() : null;
  if (!row?.img || (ext === 'png') !== (row.mime === 'image/png')) return Response.redirect(`${siteUrl(env)}og.png`, 302);
  return new Response(unb64(row.img), { headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=2592000, immutable', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' } });
}

const ROUTES = {
  'GET /api/health': (req) => json(req, { ok: true }),
  'POST /api/signup': signup,
  'POST /api/login': login,
  'POST /api/logout': logout,
  'GET /api/me': me,
  'POST /api/bets/sync': syncBets,
  'GET /api/prefs': getPrefs,
  'POST /api/prefs': putPrefs,
  'POST /api/account/delete': deleteAccount,
  'POST /api/account/email': changeEmail,
  'POST /api/password/forgot': forgot,
  'POST /api/password/reset': resetPassword,
  'GET /api/push/key': pushKey,
  'POST /api/push/subscribe': pushSubscribe,
  'POST /api/push/unsubscribe': pushUnsubscribe,
  'POST /api/push/test': pushTest,
  'GET /api/alerts': listAlerts,
  'POST /api/alerts': createAlert,
  'POST /api/alerts/delete': deleteAlert,
  'GET /api/alerts/active': activeAlerts,
  'POST /api/alerts/fire': fireAlerts,
  'POST /api/share': createShare,
  'POST /api/bets/save': saveBet,
  'GET /api/plan': getPlan,
  'POST /api/redeem': redeemCode,
  'POST /api/billing/checkout': checkout,
  'POST /api/billing/portal': billingPortal,
  'POST /api/billing/webhook': stripeWebhook,
  'GET /api/admin/overview': adminOverview,
  'GET /api/admin/users': adminUsers,
  'POST /api/admin/codes': adminCreateCode,
  'POST /api/admin/codes/revoke': adminRevokeCode,
  'POST /api/admin/grant': adminGrant,
};

export default {
  async fetch(req, env) {
    if (env.ALLOW_ORIGINS) allowed = new Set(env.ALLOW_ORIGINS.split(',').map(x => x.trim()));
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const sm = (req.method === 'GET' || req.method === 'HEAD') && url.pathname.match(/^\/s\/([A-Za-z0-9]+)(?:\.(jpg|png))?\/?$/);
    if (sm) {
      try {
        await ensureSchema(env.DB);
        return await (sm[2] ? shareImage(req, env.DB, env, sm[1], sm[2]) : sharePage(req, env.DB, env, sm[1]));
      } catch (err) {
        console.error(err);
        return Response.redirect(siteUrl(env), 302);
      }
    }
    const handler = ROUTES[`${req.method} ${url.pathname}`];
    if (!handler) return fail(req, 404, 'Not found.');
    if (req.method === 'POST' && !/^application\/json/.test(req.headers.get('Content-Type') || '')) return fail(req, 415, 'Send JSON.');
    try {
      await ensureSchema(env.DB);
      return await handler(req, env.DB, env);
    } catch (err) {
      if (err instanceof HttpError) return fail(req, err.status, err.message);
      console.error(err);
      return fail(req, 500, 'Something went wrong. Please try again.');
    }
  },
};
