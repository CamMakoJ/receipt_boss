import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { start, stop, client, adminClient, img, DATA_DIR } from './helper.js';
import { db, tx, afterCommit, onRollback } from '../server/db.js';
import { purgeSessions } from '../server/auth.js';
import { CSP } from '../server/security.js';

before(start); after(stop);

const raw = async (c, method, url, body, headers = {}) => c.raw(method, url, body, headers);

test('security headers + CSP on pages and API; private API data is never cached blindly', async () => {
  const c = await adminClient();
  const api = await c.get('/api/projects');
  for (const [k, v] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'no-referrer'], ['cross-origin-opener-policy', 'same-origin'], ['cache-control', 'private, no-cache']])
    assert.equal(api.headers.get(k), v, k);
  assert.equal(api.headers.get('content-security-policy'), CSP);
  assert.equal(api.headers.get('strict-transport-security'), null);                    // plain HTTP: no HSTS
  assert.equal(api.headers.get('x-powered-by'), null);

  assert.match(CSP, /default-src 'self'/); assert.match(CSP, /object-src 'none'/); assert.match(CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(CSP, /'unsafe-inline'|'unsafe-eval'|\*/);                              // no inline scripts/styles, no eval, no wildcards
  assert.match(CSP, /script-src 'self' 'wasm-unsafe-eval'/);                             // OCR engine (WebAssembly) only

  // the static app gets them too, and revalidates instead of caching blindly
  const page = await c.raw('GET', '/', undefined, { 'content-type': 'text/html' });
  assert.equal(page.headers.get('content-security-policy'), CSP);
  assert.equal(page.headers.get('cache-control'), 'no-cache');

  // photo URLs: per-photo ids are immutable, the cover URL always revalidates
  const p = (await c.post('/api/projects', { name: 'H' })).body;
  const r = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-01-01', vendor: 'V', subtotal: 100, images: [img(1)] })).body;
  assert.match((await c.get(`/api/receipts/${r.id}/photos/${r.photos[0]}`)).headers.get('cache-control'), /immutable/);
  assert.equal((await c.get(`/api/receipts/${r.id}/image`)).headers.get('cache-control'), 'private, no-cache');
});

test('request size limits: 100 KB for normal JSON, large only on the photo routes, 15 MB per photo', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Limits' })).body;
  const big = 'x'.repeat(200 * 1024);
  const tooBig = await c.post('/api/projects', { name: 'x', notes: big });
  assert.equal(tooBig.status, 413); assert.equal(tooBig.body.error, 'request too large');
  assert.equal((await raw(c, 'POST', '/api/projects', undefined, { 'content-type': 'application/json' })).status, 400);   // empty body: handled, not a crash

  // a 2 MB photo body is fine on a photo route (a JPEG's bytes are all that matters, so pad after a valid header)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024, 1)]).toString('base64');
  assert.equal((await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-01-01', vendor: 'Big', subtotal: 5, images: [jpeg] })).status, 201);

  // but not 16 MB in one photo
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16 * 1024 * 1024, 1)]).toString('base64');
  const r = await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-01-02', vendor: 'Huge', subtotal: 5, images: [huge] });
  assert.equal(r.status, 413); assert.match(r.body.error, /15 MB/);
  assert.equal((await c.get(`/api/projects/${p.id}`)).body.receipts.filter((x) => x.vendor === 'Huge').length, 0);   // nothing saved
});

test('rate limits: exports and backups are limited per minute; the general API has generous headroom', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Rate' })).body;
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) { const r = await c.get(`/api/projects/${p.id}/report.csv`); if (r.status === 429) limited = r; }
  assert.ok(limited, 'the 31st export in a minute is refused');
  assert.match(limited.body.error, /Too many exports/);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await c.get('/api/projects')).status, 200);                             // normal browsing is unaffected
});

test('sessions: capped per account, expired ones purged, other users untouched', async () => {
  const admin = await adminClient();
  await admin.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  const first = client(); await first.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  assert.equal((await first.get('/api/auth/me')).status, 200);
  for (let i = 0; i < 21; i++) await client().post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  const uid = db.prepare("SELECT id FROM users WHERE username = 'bob'").get().id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(uid).n, 20);
  assert.equal((await first.get('/api/auth/me')).status, 401);                          // the oldest sign-in was dropped
  assert.equal((await admin.get('/api/auth/me')).status, 200);

  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run('old1', uid, Date.now() - 1000, 1);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run('old2', uid, Date.now() - 5000, 1);
  assert.equal(purgeSessions(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE token_hash LIKE 'old%'").get().n, 0);
});

test('files are owner-only, and AI server addresses that reach cloud metadata are refused', async () => {
  if (process.platform !== 'win32') {
    const mode = (f) => fs.statSync(f).mode & 0o777;
    assert.equal(mode(DATA_DIR), 0o700); assert.equal(mode(path.join(DATA_DIR, 'images')), 0o700); assert.equal(mode(path.join(DATA_DIR, 'receipts.db')), 0o600);
    const c = await adminClient();
    const p = (await c.post('/api/projects', { name: 'Perm' })).body;
    const r = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-01-01', vendor: 'P', subtotal: 1, images: [img(1)] })).body;
    const file = fs.readdirSync(path.join(DATA_DIR, 'images'))[0];
    assert.equal(mode(path.join(DATA_DIR, 'images', file)), 0o600); assert.ok(r.id);
  }
  const c = await adminClient();
  for (const bad of ['http://169.254.169.254/latest', 'http://metadata.google.internal/v1', 'http://[fe80::1]/v1'])
    assert.equal((await c.put('/api/ai', { enabled: true, base_url: bad, model: 'x' })).status, 400, bad);
  assert.equal((await c.put('/api/ai', { enabled: false, base_url: 'http://192.168.1.20:11434/v1', model: 'x' })).status, 200);   // a LAN address is fine
});

test('file operations follow the database outcome: deleted only after COMMIT, new files dropped on ROLLBACK', () => {
  const f = (n) => { const p = path.join(DATA_DIR, 'images', n); fs.writeFileSync(p, 'x'); return p; };
  const rm = (p) => fs.rmSync(p, { force: true });

  const a = f('commit.tmp');
  tx(() => { afterCommit(() => rm(a)); assert.equal(fs.existsSync(a), true); });          // still there inside the transaction
  assert.equal(fs.existsSync(a), false);                                                  // gone after commit

  const b = f('rollback-old.tmp'), n = f('rollback-new.tmp');
  assert.throws(() => tx(() => { afterCommit(() => rm(b)); onRollback(() => rm(n)); throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(b), true);                                                   // the old file survives a failed change
  assert.equal(fs.existsSync(n), false);                                                  // the new one is cleaned up
  rm(b);

  const c = f('outside.tmp'); afterCommit(() => rm(c));                                   // outside a transaction: runs immediately
  assert.equal(fs.existsSync(c), false);
});

test('responses are compressed when worthwhile (JSON lists), photos are not', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Compress' })).body;
  for (let i = 0; i < 25; i++) await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-02-01', vendor: `Vendor number ${i}`, description: 'A reasonably descriptive line of text', subtotal: 1000 + i, images: i === 0 ? [img(1)] : [] });
  const list = await c.get('/api/receipts', { 'accept-encoding': 'gzip' });
  assert.equal(list.headers.get('content-encoding'), 'gzip');
  assert.equal(list.body.filter((r) => r.project_name === 'Compress').length, 25);          // (fetch transparently decompresses)
  const first = list.body.find((r) => r.photos.length);
  const photo = await c.get(`/api/receipts/${first.id}/photos/${first.photos[0]}`, { 'accept-encoding': 'gzip' });
  assert.equal(photo.headers.get('content-encoding'), null);
});
