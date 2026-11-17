import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { normVendor, buildVendorIndex, indexByKey, suggestFor } from '../public/vendor.js';
import { start, stop, client, adminClient } from './helper.js';

before(start); after(stop);

test('store names that differ only by number, case, punctuation or "Inc/Canada" are the same store', () => {
  for (const v of ['HOME DEPOT #7011', 'Home Depot', 'home depot 7011', "Home Depot Canada Inc.", ' home-depot ']) assert.equal(normVendor(v), 'home depot', v);
  assert.equal(normVendor("Tim Hortons #1234"), 'tim hortons');
  assert.equal(normVendor("Lowe's"), 'lowe s');
  assert.equal(normVendor('A&W'), 'a&w');
  assert.equal(normVendor(''), ''); assert.equal(normVendor(null), '');
});

const row = (vendor, category, billable, date = '2026-01-01') => ({ vendor, category, billable, date });

test('index: counts, most common category / billable, latest spelling, most-used first', () => {
  const list = buildVendorIndex([
    row('Home Depot', 'Materials', 1, '2026-01-01'), row('HOME DEPOT #7011', 'Materials', 1, '2026-02-01'), row('Home Depot', 'Tools & equipment', 0, '2026-03-01'),
    row('Pub', 'Meals', 0), row('', 'Meals', 1), row('Shell', '', 1), row('Shell', '', 1), row('Shell', 'Fuel', 1),
  ]);
  assert.deepEqual(list.map((e) => e.key), ['home depot', 'shell', 'pub']);
  const hd = list[0];
  assert.deepEqual([hd.count, hd.category, hd.billable, hd.name], [3, 'Materials', 1, 'Home Depot']);
  assert.ok(Math.abs(hd.cshare - 2 / 3) < 1e-9 && Math.abs(hd.bshare - 2 / 3) < 1e-9);
  assert.equal(buildVendorIndex([row('HOME DEPOT #7011', 'Materials', 1, '2026-05-01')])[0].name, 'HOME DEPOT');   // store number dropped from the display name
  assert.equal(list[1].category, 'Fuel'); assert.equal(list[1].cshare, 1);                      // share counts only receipts that had a category
});

test('suggestions appear only once the habit is clear', () => {
  const m = (rows) => indexByKey(buildVendorIndex(rows));
  assert.equal(suggestFor(m([row('Home Depot', 'Materials', 1)]), 'home depot'), null);             // seen once: not yet
  const two = suggestFor(m([row('Home Depot', 'Materials', 1), row('Home Depot', 'Materials', 1)]), 'HOME DEPOT #55');
  assert.deepEqual([two.category, two.billable], ['Materials', 1]);
  const scattered = suggestFor(m([row('Costco', 'Groceries', 1), row('Costco', 'Fuel', 1), row('Costco', 'Office supplies', 1)]), 'costco');
  assert.deepEqual([scattered.category, scattered.billable], ['', 1]);                             // no clear category, but always billable
});

test('...a split decision suggests nothing for that field', () => {
  const m = indexByKey(buildVendorIndex([row('Costco', 'Groceries', 1), row('Costco', 'Fuel', 0), row('Costco', 'Fuel', 1), row('Costco', 'Groceries', 0)]));
  assert.equal(suggestFor(m, 'Costco'), null);                                                        // 50/50 on both: stay quiet
  const half = indexByKey(buildVendorIndex([row('Pub', 'Meals', 0), row('Pub', 'Meals', 0), row('Pub', 'Meals', 1)]));
  const s = suggestFor(half, 'Pub');
  assert.deepEqual([s.category, s.billable], ['Meals', null]);                                       // 67% billable < 70%: category only
});

test('endpoint: your receipts only, drafts ignored; items scope is shared', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'V' })).body;
  for (let i = 0; i < 3; i++) await c.post(`/api/projects/${p.id}/receipts`, { date: `2026-03-0${i + 1}`, vendor: i ? 'HOME DEPOT #7011' : 'Home Depot', category: 'Materials', billable: true, subtotal: 100 + i });
  await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-09', vendor: 'Draft Shop', category: 'Fuel', subtotal: 5, draft: true });
  const list = (await c.get('/api/vendors')).body;
  assert.deepEqual(list.map((e) => [e.key, e.count, e.category, e.billable]), [['home depot', 3, 'Materials', 1]]);

  await c.post('/api/items', { name: 'Fridge', category: 'Appliance', vendor: 'Costco', purchase_date: '2025-01-01', price: 1 });
  await c.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  const bob = client(); await bob.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  assert.deepEqual((await bob.get('/api/vendors')).body, []);                                          // receipts are private
  assert.deepEqual((await bob.get('/api/vendors?scope=items')).body.map((e) => e.key), ['costco']);     // household items are shared
});
