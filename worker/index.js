// fck the vig — accounts API (Cloudflare Worker + D1 database bound as DB).
// Stores a username, a salted PBKDF2 password hash, login sessions and each user's saved bets.
// No email or other personal details are collected.

const ORIGINS = ['https://www.fckvig.com', 'https://fckvig.com', 'https://grebstar.github.io'];
let allowed = new Set(ORIGINS);  // ALLOW_ORIGINS (comma-separated) overrides this, e.g. for local testing
const SESSION_DAYS = 90;
const PBKDF2_ITER = 100000;          // Workers' maximum
const MAX_BETS = 1000;
const MAX_BET_BYTES = 8000;
const MAX_BODY = 600000;
const USER_RE = /^[a-z0-9_]{3,20}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pw TEXT NOT NULL, created_at INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS bets (user_id INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id))`,
  `CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
];
let schemaReady = null;
const ensureSchema = db => (schemaReady ||= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { schemaReady = null; throw e; }));

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
function cleanPassword(p) {
  const v = String(p ?? '');
  if (v.length < 8 || v.length > 200) throw new HttpError(400, 'Passwords need at least 8 characters.');
  return v;
}

// ---------- routes ----------
async function signup(req, db) {
  const b = await body(req);
  const username = cleanUsername(b.username);
  const password = cleanPassword(b.password);
  if (b.adult !== true) throw new HttpError(400, 'You need to confirm you are of legal betting age.');
  await limit(db, 'signup:' + await ipKey(req), 5, 3600e3);
  const exists = await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  if (exists) throw new HttpError(409, 'That username is taken.');
  const pw = await hashPassword(password);
  const res = await db.prepare('INSERT INTO users (username, pw, created_at) VALUES (?, ?, ?)').bind(username, pw, Date.now()).run();
  const id = res.meta.last_row_id;
  return json(req, { token: await newSession(db, id), username });
}

async function login(req, db) {
  const b = await body(req);
  const username = String(b.username ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  await limit(db, 'login:' + await ipKey(req), 30, 15 * 60e3);
  const u = USER_RE.test(username) ? await db.prepare('SELECT id, pw, failed, locked_until FROM users WHERE username = ?').bind(username).first() : null;
  if (u && u.locked_until > Date.now()) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
  const ok = u ? await checkPassword(password, u.pw) : (await pbkdf2(password, new Uint8Array(16), PBKDF2_ITER), false);
  if (!ok) {
    if (u) {
      const failed = u.failed + 1;
      await db.prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?')
        .bind(failed >= 10 ? 0 : failed, failed >= 10 ? Date.now() + 15 * 60e3 : 0, u.id).run();
    }
    throw new HttpError(401, 'Wrong username or password.');
  }
  if (u.failed) await db.prepare('UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?').bind(u.id).run();
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(u.id, Date.now()).run();
  return json(req, { token: await newSession(db, u.id), username });
}

async function logout(req, db) {
  const u = await auth(req, db);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(u.tokenHash).run();
  return json(req, { ok: true });
}

async function me(req, db) {
  const u = await auth(req, db);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM bets WHERE user_id = ? AND deleted = 0').bind(u.id).first();
  return json(req, { username: u.username, created_at: u.created_at, bets: n?.n || 0 });
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
      return await handler(req, env.DB);
    } catch (err) {
      if (err instanceof HttpError) return fail(req, err.status, err.message);
      console.error(err);
      return fail(req, 500, 'Something went wrong. Please try again.');
    }
  },
};
