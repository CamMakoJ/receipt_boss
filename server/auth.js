import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, tx } from './db.js';
import { err, wrap, str, rmImage } from './http.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'rb_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ---------------------------------------------------------------- passwords
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
const DUMMY = await hashPassword('dummy-password-for-timing');
export async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw err(400, 'password must be at least 8 characters');
  if (pw.length > 200) throw err(400, 'password too long');
}
function checkUsername(u) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(u || '')) throw err(400, 'username must be 3-32 letters, numbers, . _ -');
  return u;
}

// ---------------------------------------------------------------- sessions
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function readCookie(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}
const isSecure = (req) => !!(req.secure || req.socket.encrypted);
function setCookie(req, res, value, maxAgeSec) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`);
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(sha(token), userId, now + SESSION_MS, now);
  setCookie(req, res, token, SESSION_MS / 1000);
}

/** Attaches req.user when a valid session cookie is present. */
export function sessionMiddleware(req, res, next) {
  const token = readCookie(req);
  if (token) {
    const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.username, u.role FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
    if (row && row.expires_at > Date.now()) {
      req.user = { id: row.id, username: row.username, role: row.role };
      if (row.expires_at - Date.now() < SESSION_MS - 24 * 3600 * 1000) { // slide the expiry at most daily
        db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_MS, row.token_hash);
        setCookie(req, res, token, SESSION_MS / 1000);
      }
    }
  }
  next();
}
export function requireAuth(req, res, next) { if (!req.user) return next(err(401, 'login required')); next(); }
export function requireAdmin(req, res, next) { if (req.user?.role !== 'admin') return next(err(403, 'admin only')); next(); }

// ---------------------------------------------------------------- brute-force throttle
const fails = new Map(); // key -> { n, until }
function throttle(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now()) throw err(429, `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s`);
}
function failed(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (f.n - 5));
  fails.set(key, f);
}

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const me = (u) => (u ? { id: u.id, username: u.username, role: u.role } : null);

export function registerAuth(app) {
  // Public: tells the client whether to show setup / login / the app.
  app.get('/api/auth/status', (req, res) => res.json({ needsSetup: userCount() === 0, user: me(req.user) }));

  app.post('/api/auth/setup', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    checkUsername(username); checkPassword(password);
    const hash = await hashPassword(password);
    const id = tx(() => {
      if (userCount() > 0) throw err(409, 'already set up');
      const r = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?,?, 'admin')").run(username, hash);
      db.prepare('UPDATE projects SET user_id = ? WHERE user_id IS NULL').run(r.lastInsertRowid); // adopt pre-accounts data
      return r.lastInsertRowid;
    });
    startSession(req, res, id);
    res.status(201).json({ user: { id, username, role: 'admin' } });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const username = str(req.body?.username, 64), password = String(req.body?.password ?? '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    throttle(key);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = await verifyPassword(password, u ? u.password_hash : DUMMY);
    if (!u || !ok) { failed(key); throw err(401, 'wrong username or password'); }
    fails.delete(key);
    startSession(req, res, u.id);
    res.json({ user: me(u) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    const token = readCookie(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    setCookie(req, res, '', 0);
    res.status(204).end();
  });

  // ---- everything below needs a session
  app.use('/api', (req, res, next) => (req.path.startsWith('/auth/') ? next() : requireAuth(req, res, next)));

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: me(req.user) }));

  app.post('/api/auth/password', requireAuth, wrap(async (req, res) => {
    const { current, password } = req.body || {};
    checkPassword(password);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(String(current ?? ''), u.password_hash))) throw err(403, 'current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, sha(readCookie(req))); // sign out other devices
    res.status(204).end();
  }));

  // ---- admin: user management
  app.get('/api/users', requireAdmin, (req, res) => {
    res.json(db.prepare(`SELECT u.id, u.username, u.role, u.created_at, (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS projects
      FROM users u ORDER BY u.username COLLATE NOCASE`).all());
  });
  app.post('/api/users', requireAdmin, wrap(async (req, res) => {
    const { username, password, role } = req.body || {};
    checkUsername(username); checkPassword(password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw err(409, 'username already exists');
    const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
      .run(username, await hashPassword(password), role === 'admin' ? 'admin' : 'user');
    res.status(201).json({ id: r.lastInsertRowid, username, role: role === 'admin' ? 'admin' : 'user' });
  }));
  const adminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  app.patch('/api/users/:id', requireAdmin, wrap(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw err(404, 'user not found');
    const { password, role } = req.body || {};
    if (password !== undefined) {
      checkPassword(password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (role !== undefined) {
      if (role !== 'admin' && u.role === 'admin' && adminCount() <= 1) throw err(400, 'there must be at least one admin');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'user', u.id);
    }
    res.status(204).end();
  }));
  app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw err(404, 'user not found');
    if (u.id === req.user.id) throw err(400, 'you cannot delete your own account');
    if (u.role === 'admin' && adminCount() <= 1) throw err(400, 'there must be at least one admin');
    const files = db.prepare(`SELECT rp.file FROM receipt_photos rp JOIN receipts r ON r.id = rp.receipt_id
      JOIN projects p ON p.id = r.project_id WHERE p.user_id = ?`).all(u.id).map((x) => x.file);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // cascades to projects, receipts, photo rows, sessions
    files.forEach(rmImage);
    res.status(204).end();
  });
}
