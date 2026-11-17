import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { start, stop, client, adminClient, img } from './helper.js';

before(start); after(stop);

const base = { date: '2026-03-14', vendor: 'Home Depot', description: 'Lumber', subtotal: 8475, gst: 424, pst: 593, billable: true };

test('duplicate warning: same day + vendor + total, across projects; can be overridden; retries are not duplicates', async () => {
  const c = await adminClient();
  const a = (await c.post('/api/projects', { name: 'A' })).body, b = (await c.post('/api/projects', { name: 'B' })).body;
  const first = await c.post(`/api/projects/${a.id}/receipts`, { ...base, client_id: 'u1' });
  assert.equal(first.status, 201);

  const dup = await c.post(`/api/projects/${b.id}/receipts`, { ...base, vendor: 'home depot ', description: 'other words' });   // other project, case/space differences
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'This looks like a receipt you already entered');
  assert.equal(dup.body.duplicates.length, 1);
  assert.deepEqual([dup.body.duplicates[0].number, dup.body.duplicates[0].project_name, dup.body.duplicates[0].total], [1, 'A', 9492]);
  assert.equal((await c.get(`/api/projects/${b.id}`)).body.receipts.length, 0);                 // nothing was saved

  assert.equal((await c.post(`/api/projects/${b.id}/receipts`, { ...base, allow_duplicate: true })).status, 201);    // "save anyway"
  assert.equal((await c.post(`/api/projects/${b.id}/receipts`, { ...base, date: '2026-03-15' })).status, 201);       // different day
  assert.equal((await c.post(`/api/projects/${b.id}/receipts`, { ...base, subtotal: 8476, date: '2026-04-01' })).status, 201);
  assert.equal((await c.post(`/api/projects/${a.id}/receipts`, { ...base, client_id: 'u1' })).status, 200);          // offline retry: returns the original
  assert.equal((await c.post(`/api/projects/${a.id}/receipts`, { date: '2026-05-05', description: 'No vendor', subtotal: 100 })).status, 201);
  assert.equal((await c.post(`/api/projects/${b.id}/receipts`, { date: '2026-05-05', description: 'no VENDOR', subtotal: 100 })).status, 409);  // falls back to description
  assert.equal((await c.post(`/api/projects/${a.id}/receipts`, { date: '2026-06-06', vendor: 'Zero' })).status, 201);   // zero totals are never "duplicates"
  assert.equal((await c.post(`/api/projects/${a.id}/receipts`, { date: '2026-06-06', vendor: 'Zero' })).status, 201);

  // other users' receipts are never compared
  await c.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  const bob = client(); await bob.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  const bp = (await bob.post('/api/projects', { name: 'Bob' })).body;
  assert.equal((await bob.post(`/api/projects/${bp.id}/receipts`, base)).status, 201);
});

test('household items: duplicate warning on name + date + price', async () => {
  const c = await adminClient();
  const item = { name: 'Samsung TV', purchase_date: '2025-06-30', price: 129999 };
  assert.equal((await c.post('/api/items', item)).status, 201);
  const dup = await c.post('/api/items', { ...item, name: 'samsung tv' });
  assert.equal(dup.status, 409); assert.equal(dup.body.duplicates[0].name, 'Samsung TV');
  assert.equal((await c.post('/api/items', { ...item, allow_duplicate: true })).status, 201);
  assert.equal((await c.post('/api/items', { ...item, price: 99999 })).status, 201);
});

test('invoiced/paid tracking: bulk updates, summary, export filters, CSV + PDF', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Billing test', client: 'ACME' })).body;
  const mk = async (o) => (await c.post(`/api/projects/${p.id}/receipts`, { ...base, allow_duplicate: true, image: img(1), ...o })).body;
  const r1 = await mk({ description: 'Lumber', date: '2026-03-01' });
  const r2 = await mk({ description: 'Screws', subtotal: 2000, gst: 100, pst: 140, date: '2026-03-10' });
  const r3 = await mk({ description: 'Team lunch', vendor: 'Pub', billable: false, date: '2026-03-12' });
  assert.equal(r1.billing_status, 'unbilled');

  let proj = (await c.get(`/api/projects/${p.id}`)).body;
  assert.deepEqual([proj.billing.unbilled.count, proj.billing.unbilled.total, proj.billing.invoiced.count], [2, 9492 + 2240, 0]);

  // validation + ownership
  assert.equal((await c.post(`/api/projects/${p.id}/billing`, { ids: [r1.id], status: 'bogus' })).status, 400);
  assert.equal((await c.post(`/api/projects/${p.id}/billing`, { ids: [], status: 'paid' })).status, 400);

  // invoice r1 (+ the non-billable r3, which must be ignored)
  const inv = await c.post(`/api/projects/${p.id}/billing`, { ids: [r1.id, r3.id], status: 'invoiced', invoice_ref: 'INV-001' });
  assert.deepEqual(inv.body, { updated: 1 });
  proj = (await c.get(`/api/projects/${p.id}`)).body;
  const by = Object.fromEntries(proj.receipts.map((r) => [r.description, r]));
  assert.deepEqual([by.Lumber.billing_status, by.Lumber.invoice_ref, by['Team lunch'].billing_status], ['invoiced', 'INV-001', 'unbilled']);
  assert.match(by.Lumber.invoiced_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual([proj.billing.unbilled.count, proj.billing.invoiced.count, proj.billing.invoiced.total], [1, 1, 9492]);

  const csv = async (q) => (await c.get(`/api/projects/${p.id}/report.csv?${q}`)).body.toString();
  const names = (text) => text.trim().split('\r\n').slice(1).map((l) => l.split(',')[6]).sort();
  assert.deepEqual(names(await csv('')), ['Lumber', 'Screws', 'Team lunch']);
  assert.deepEqual(names(await csv('billing=unbilled')), ['Screws', 'Team lunch']);                 // non-billable pass through...
  assert.deepEqual(names(await csv('billing=unbilled&only=billable')), ['Screws']);                  // ...unless only=billable
  assert.deepEqual(names(await csv('only=billable&invoice=INV-001')), ['Lumber']);
  assert.deepEqual(names(await csv('billing=invoiced&only=billable')), ['Lumber']);
  assert.match(await csv('only=billable&invoice=INV-001'), /,Billing status,Invoice\r\n.*,invoiced,INV-001\r\n/s);
  assert.equal(names(await csv('billing=paid')).includes('Lumber'), false);

  // the bundle's PDF names the invoice
  const zip = await c.get(`/api/projects/${p.id}/export.zip?only=billable&invoice=INV-001`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-inv-'));
  fs.writeFileSync(path.join(dir, 'x.zip'), zip.body);
  execFileSync('unzip', ['-q', path.join(dir, 'x.zip'), '-d', dir]);
  const sub = fs.readdirSync(dir).find((d) => d.endsWith('_receipts'));
  assert.deepEqual(fs.readdirSync(path.join(dir, sub, 'receipts')), ['001_Lumber.jpg']);
  assert.match(execFileSync('pdftotext', ['-layout', path.join(dir, sub, 'report.pdf'), '-']).toString(), /Invoice: INV-001/);

  // paid keeps the reference; back to unbilled clears it; edits via PATCH work too
  await c.post(`/api/projects/${p.id}/billing`, { ids: [r1.id], status: 'paid' });
  const paid = (await c.get(`/api/receipts/${r1.id}`)).body;
  assert.deepEqual([paid.billing_status, paid.invoice_ref], ['paid', 'INV-001']);
  await c.post(`/api/projects/${p.id}/billing`, { ids: [r1.id], status: 'unbilled' });
  const back = (await c.get(`/api/receipts/${r1.id}`)).body;
  assert.deepEqual([back.billing_status, back.invoice_ref, back.invoiced_at], ['unbilled', '', null]);
  assert.equal((await c.patch(`/api/receipts/${r2.id}`, { billing_status: 'invoiced', invoice_ref: 'INV-002' })).body.billing_status, 'invoiced');
  assert.equal((await c.patch(`/api/receipts/${r2.id}`, { billing_status: 'nope' })).status, 400);

  // all receipts endpoint (cross-project search source)
  const all = (await c.get('/api/receipts')).body;
  assert.ok(all.length >= 3 && all.every((r) => r.project_name));
  assert.equal(all.every((r) => r.ocr_text.length <= 1500), true);

  // another user can't touch this project
  await c.post('/api/users', { username: 'eve', password: 'eves-password-1' });
  const eve = client(); await eve.post('/api/auth/login', { username: 'eve', password: 'eves-password-1' });
  assert.equal((await eve.post(`/api/projects/${p.id}/billing`, { ids: [r1.id], status: 'paid' })).status, 404);
  assert.equal((await eve.get('/api/receipts')).body.length, 0);
});
