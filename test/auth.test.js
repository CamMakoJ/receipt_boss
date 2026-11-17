import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, client, adminClient, img } from './helper.js';

before(start); after(stop);

test('first-run setup, login, logout, and API requires a session', async () => {
  const anon = client();
  assert.deepEqual((await anon.get('/api/auth/status')).body, { needsSetup: true, user: null });
  assert.equal((await anon.get('/api/projects')).status, 401);

  assert.equal((await anon.post('/api/auth/setup', { username: 'ab', password: 'longenough1' })).status, 400); // short username
  assert.equal((await anon.post('/api/auth/setup', { username: 'alice', password: 'short' })).status, 400);
  const s = await anon.post('/api/auth/setup', { username: 'alice', password: 'correct-horse-battery' });
  assert.equal(s.status, 201);
  assert.equal(s.body.user.role, 'admin');
  assert.match(s.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  assert.equal((await anon.post('/api/auth/setup', { username: 'mallory', password: 'correct-horse-battery' })).status, 409);

  assert.equal((await anon.get('/api/projects')).status, 200);
  await anon.post('/api/auth/logout');
  assert.equal((await anon.get('/api/projects')).status, 401);

  const bad = await anon.post('/api/auth/login', { username: 'alice', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const ok = await anon.post('/api/auth/login', { username: 'ALICE', password: 'correct-horse-battery' }); // usernames are case-insensitive
  assert.equal(ok.status, 200);
});

test('state-changing calls need the X-RB header (CSRF defence)', async () => {
  const a = await adminClient('alice');
  const r = await a.raw('POST', '/api/projects', { name: 'x' }, { 'x-rb': '' });
  assert.equal(r.status, 403);
});

test('login throttling after repeated failures', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { username: 'bruteforce', password: 'nope-nope-nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'bruteforce', password: 'nope-nope-nope' })).status, 429);
});

test('users only see their own projects/receipts; household items are shared; admin-only routes', async () => {
  const alice = await adminClient('alice');
  const mk = await alice.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  assert.equal(mk.status, 201);
  const bob = client();
  assert.equal((await bob.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' })).status, 200);

  const p = (await alice.post('/api/projects', { name: 'Alice private', province: 'ON' })).body;
  const r = (await alice.post(`/api/projects/${p.id}/receipts`, { subtotal: 1000, image: img(1) })).body;

  assert.deepEqual((await bob.get('/api/projects')).body, []);
  for (const u of [`/api/projects/${p.id}`, `/api/receipts/${r.id}`, `/api/receipts/${r.id}/image`, `/api/projects/${p.id}/report.csv`, `/api/projects/${p.id}/export.zip`])
    assert.equal((await bob.get(u)).status, 404, u);
  assert.equal((await bob.patch(`/api/receipts/${r.id}`, { vendor: 'hax' })).status, 404);
  assert.equal((await bob.del(`/api/receipts/${r.id}`)).status, 404);
  assert.equal((await bob.post(`/api/projects/${p.id}/receipts`, { subtotal: 5 })).status, 404);

  // bob cannot move/duplicate into alice's project either way
  const bp = (await bob.post('/api/projects', { name: 'Bob proj' })).body;
  const br = (await bob.post(`/api/projects/${bp.id}/receipts`, { subtotal: 5 })).body;
  assert.equal((await bob.patch(`/api/receipts/${br.id}`, { project_id: p.id })).status, 404);

  // admin-only
  for (const [m, u] of [['get', '/api/users'], ['get', '/api/backup'], ['post', '/api/backup/run'], ['get', '/api/backup/download']])
    assert.equal((await bob[m](u)).status, 403, u);

  // shared household
  const it = await alice.post('/api/items', { name: 'Fridge', purchase_date: '2025-01-01' });
  assert.equal(it.status, 201);
  assert.equal((await bob.get('/api/items')).body.length, 1);

  // password change signs out other sessions
  const bob2 = client();
  await bob2.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  assert.equal((await bob.post('/api/auth/password', { current: 'wrong', password: 'new-password-123' })).status, 403);
  assert.equal((await bob.post('/api/auth/password', { current: 'bobs-password-1', password: 'new-password-123' })).status, 204);
  assert.equal((await bob.get('/api/auth/me')).status, 200);
  assert.equal((await bob2.get('/api/auth/me')).status, 401);

  // admin guard rails + deleting a user removes their data/images
  assert.equal((await alice.del(`/api/users/${(await alice.get('/api/auth/me')).body.user.id}`)).status, 400);
  assert.equal((await alice.patch(`/api/users/${(await alice.get('/api/auth/me')).body.user.id}`, { role: 'user' })).status, 400);
  assert.equal((await alice.del(`/api/users/${mk.body.id}`)).status, 204);
  assert.equal((await bob.get('/api/projects')).status, 401);
});
