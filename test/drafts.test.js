import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, client, adminClient, img } from './helper.js';

before(start); after(stop);
const base = { date: '2026-03-14', vendor: 'Home Depot', description: 'Lumber', subtotal: 8475, gst: 424, pst: 593 };

test('quick-capture drafts stay out of totals, reports, search and duplicate checks until reviewed', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Inbox test' })).body;
  const q = (await c.post('/api/projects', { name: 'Other project' })).body;

  const real = (await c.post(`/api/projects/${p.id}/receipts`, { ...base, description: 'Real one', date: '2026-03-01', subtotal: 1000 })).body;
  assert.equal(real.number, 1);

  const d1 = (await c.post(`/api/projects/${p.id}/receipts`, { ...base, draft: true, images: [img(1)] })).body;
  const d2 = (await c.post(`/api/projects/${p.id}/receipts`, { ...base, draft: true, images: [img(2)] })).body;      // identical draft: no duplicate warning
  assert.equal(d1.draft, true); assert.ok(d1.number < 0 && d2.number < 0 && d1.number !== d2.number);
  assert.equal(d1.check.status, 'none');

  // excluded from everything that counts
  const detail = (await c.get(`/api/projects/${p.id}`)).body;
  assert.equal(detail.all.count, 1); assert.equal(detail.receipts.length, 1); assert.equal(detail.drafts.length, 2);
  assert.equal((await c.get('/api/projects')).body.find((x) => x.id === p.id).all.count, 1);
  assert.equal((await c.get('/api/receipts')).body.length, 1);
  const csv = (await c.get(`/api/projects/${p.id}/report.csv`)).body.toString();
  assert.equal(csv.trim().split('\r\n').length, 2);                                                                   // header + the one real receipt
  // billing ignores drafts
  assert.deepEqual((await c.post(`/api/projects/${p.id}/billing`, { ids: [d1.id, real.id], status: 'invoiced', invoice_ref: 'X' })).body, { updated: 1 });

  // the inbox lists them across projects, oldest first, with the project name
  const other = (await c.post(`/api/projects/${q.id}/receipts`, { date: '2026-04-01', vendor: 'Pub', subtotal: 500, draft: true })).body;
  const inbox = (await c.get('/api/inbox')).body;
  assert.deepEqual(inbox.map((x) => x.id), [d1.id, d2.id, other.id]);
  assert.equal(inbox[2].project_name, 'Other project'); assert.equal(inbox[0].photos.length, 1);

  // other users never see them
  await c.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  const bob = client(); await bob.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  assert.deepEqual((await bob.get('/api/inbox')).body, []);
  assert.equal((await bob.patch(`/api/receipts/${d1.id}`, { draft: false })).status, 404);

  // review: edit + finalize -> becomes a real receipt with the next number; no gaps from deleted drafts
  await c.del(`/api/receipts/${d2.id}`);
  const fin = (await c.patch(`/api/receipts/${d1.id}`, { draft: false, description: 'Reviewed', subtotal: 2000, gst: 100, pst: 140 })).body;
  assert.equal(fin.draft, false); assert.equal(fin.number, 2);
  const after = (await c.get(`/api/projects/${p.id}`)).body;
  assert.deepEqual([after.all.count, after.drafts.length], [2, 0]);
  assert.equal((await c.get(`/api/projects/${p.id}/report.csv`)).body.toString().trim().split('\r\n').length, 3);

  // finalizing runs the duplicate check; "save anyway" overrides
  const dup = (await c.post(`/api/projects/${p.id}/receipts`, { ...base, description: 'Dupe draft', draft: true })).body;   // matches nothing yet
  await c.patch(`/api/receipts/${dup.id}`, { draft: false, vendor: 'Home Depot', date: '2026-03-01', subtotal: 1000, gst: 0, pst: 0, allow_duplicate: true });
  const d3 = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-01', vendor: 'Home Depot', subtotal: 1000, draft: true })).body;
  const blocked = await c.patch(`/api/receipts/${d3.id}`, { draft: false });
  assert.equal(blocked.status, 409); assert.ok(blocked.body.duplicates.length >= 1);
  assert.equal((await c.get(`/api/receipts/${d3.id}`)).body.draft, true);                                              // still a draft
  assert.equal((await c.patch(`/api/receipts/${d3.id}`, { draft: false, allow_duplicate: true })).body.draft, false);

  // a draft moved to another project keeps its placeholder number until reviewed
  const mv = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-05-01', vendor: 'Mover', subtotal: 700, draft: true })).body;
  const moved = (await c.patch(`/api/receipts/${mv.id}`, { project_id: q.id })).body;
  assert.ok(moved.number < 0); assert.equal(moved.project_id, q.id);

  // a real receipt can't be turned back into a draft
  assert.equal((await c.patch(`/api/receipts/${real.id}`, { draft: true })).body.draft, false);
});
