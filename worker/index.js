// fck the vig — accounts API (Cloudflare Worker + D1 database bound as DB).
// Stores a username, an email address (only used for password resets), a salted PBKDF2 password hash,
// login sessions and each user's saved bets.
//
// Password-reset emails go out through whichever of these is set up (first one wins):
//   - a Cloudflare Email Service binding named EMAIL (needs the Workers Paid plan), or
//   - a Resend API key in the secret RESEND_API_KEY (free plan: 100 emails/day).
// MAIL_FROM sets the sender (default "fck the vig <noreply@fckvig.com>"); SITE_URL the link target.

const ORIGINS = ['https://www.fckvig.com', 'https://fckvig.com', 'https://grebstar.github.io'];
let allowed = new Set(ORIGINS);  // ALLOW_ORIGINS (comma-separated) overrides this, e.g. for local testing
const SESSION_DAYS = 90;
const PBKDF2_ITER = 100000;          // Workers' maximum
const MAX_BETS = 1000;
const MAX_BET_BYTES = 8000;
const MAX_BODY = 600000;
const USER_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESET_MINUTES = 60;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pw TEXT NOT NULL, created_at INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS bets (user_id INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id))`,
  `CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
];
let schemaReady = null;
async function migrate(db) {
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  // users.email was added after launch; add it to databases created before that.
  const cols = await db.prepare('PRAGMA table_info(users)').all();
  if (!(cols.results || []).some(c => c.name === 'email')) await db.prepare('ALTER TABLE users ADD COLUMN email TEXT').run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email)').run();
}
const ensureSchema = db => (schemaReady ||= migrate(db).catch(e => { schemaReady = null; throw e; }));

// ---------- helpers ----------
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

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

async function me(req, db) {
  const u = await auth(req, db);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM bets WHERE user_id = ? AND deleted = 0').bind(u.id).first();
  const e = await db.prepare('SELECT email FROM users WHERE id = ?').bind(u.id).first();
  return json(req, { username: u.username, email: e?.email || null, created_at: u.created_at, bets: n?.n || 0 });
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
  const from = env.MAIL_FROM || 'fck the vig <noreply@fckvig.com>';
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
  const link = `${(env.SITE_URL || 'https://www.fckvig.com').replace(/\/$/, '')}/#reset=${token}`;
  const text = `Hi ${u.username},\n\nSomeone (hopefully you) asked to reset the password for your fck the vig account.\n\nSet a new password here (the link works for ${RESET_MINUTES} minutes):\n${link}\n\nIf you didn't ask for this, ignore this email. Your password won't change.\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#14062e">
<p>Hi ${u.username},</p>
<p>Someone (hopefully you) asked to reset the password for your <b>fck the vig</b> account.</p>
<p><a href="${link}" style="display:inline-block;background:#9b74ff;color:#14062e;font-weight:700;padding:12px 20px;border-radius:12px;text-decoration:none">Set a new password</a></p>
<p style="font-size:14px;color:#555">The link works for ${RESET_MINUTES} minutes. If you didn't ask for this, ignore this email. Your password won't change.</p></div>`;
  try {
    await sendMail(env, { to: u.email, subject: 'Reset your fck the vig password', text, html });
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
async function syncBets(req, db) {
  const u = await auth(req, db);
  const b = await body(req);
  const incoming = Array.isArray(b.bets) ? b.bets : [];
  if (incoming.length > MAX_BETS + 200) throw new HttpError(413, 'Too many bets.');
  const stmts = [];
  for (const bet of incoming) {
    if (!bet || typeof bet.id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(bet.id)) continue;
    const updated = Number(bet.updated);
    if (!Number.isFinite(updated) || updated <= 0) continue;
    const data = JSON.stringify(bet);
    if (data.length > MAX_BET_BYTES) continue;
    stmts.push(db.prepare(
      `INSERT INTO bets (user_id, id, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted
       WHERE excluded.updated_at > bets.updated_at`,
    ).bind(u.id, bet.id, data, Math.floor(updated), bet.deleted ? 1 : 0));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  const rows = await db.prepare('SELECT data FROM bets WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').bind(u.id, MAX_BETS + 200).all();
  const bets = (rows.results || []).map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  return json(req, { bets });
}

async function deleteAccount(req, db) {
  const u = await auth(req, db);
  const b = await body(req);
  const row = await db.prepare('SELECT pw FROM users WHERE id = ?').bind(u.id).first();
  if (!row || !(await checkPassword(String(b.password ?? ''), row.pw))) throw new HttpError(401, 'Wrong password.');
  await db.batch([
    db.prepare('DELETE FROM bets WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM resets WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(u.id),
  ]);
  return json(req, { ok: true });
}

const ROUTES = {
  'GET /api/health': (req) => json(req, { ok: true }),
  'POST /api/signup': signup,
  'POST /api/login': login,
  'POST /api/logout': logout,
  'GET /api/me': me,
  'POST /api/bets/sync': syncBets,
  'POST /api/account/delete': deleteAccount,
  'POST /api/account/email': changeEmail,
  'POST /api/password/forgot': forgot,
  'POST /api/password/reset': resetPassword,
};

export default {
  async fetch(req, env) {
    if (env.ALLOW_ORIGINS) allowed = new Set(env.ALLOW_ORIGINS.split(',').map(x => x.trim()));
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
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
