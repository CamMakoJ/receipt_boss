import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { start, stop, adminClient, img, DATA_DIR } from './helper.js';
import { calcTax, warrantyExpiry } from '../server/tax.js';

before(start); after(stop);

test('province tax maths (integer cents)', () => {
  assert.deepEqual(calcTax(10000, 'BC'), { gst: 500, pst: 700 });
  assert.deepEqual(calcTax(10000, 'AB'), { gst: 500, pst: 0 });
  assert.deepEqual(calcTax(10000, 'ON'), { gst: 1300, pst: 0 });   // HST sits in the GST/HST field
  assert.deepEqual(calcTax(10000, 'NS'), { gst: 1400, pst: 0 });
  assert.deepEqual(calcTax(10000, 'QC'), { gst: 500, pst: 998 });  // 9.975% -> 997.5 -> rounds to 998
  assert.deepEqual(calcTax(0, 'BC'), { gst: 0, pst: 0 });
});

test('warranty expiry clamps to month end', () => {
  assert.equal(warrantyExpiry('2025-03-15', 12), '2026-03-15');
  assert.equal(warrantyExpiry('2024-01-31', 1), '2024-02-29');
  assert.equal(warrantyExpiry('2025-01-31', 1), '2025-02-28');
  assert.equal(warrantyExpiry('2025-01-01', null), null);
  assert.equal(warrantyExpiry('2025-01-01', 0), null);
});

test('receipts: province, auto tax, category->description, report-time tax estimate, exports', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Deck Build / 2026', client: 'ACME', province: 'BC' })).body;
  assert.equal(p.province, 'BC');
  assert.equal((await c.post('/api/projects', { name: 'bad', province: 'XX' })).status, 400);

  // auto tax: the server ignores supplied gst/pst and uses the receipt's province
  const a = (await c.post(`/api/projects/${p.id}/receipts`, { client_id: 'abc', date: '2026-03-01', vendor: 'Home Depot', category: 'Materials',
    description: 'Lumber for deck', subtotal: 10000, gst: 1, pst: 1, tax_auto: true, billable: true, image: img(1) })).body;
  assert.equal(a.province, 'BC');
  assert.equal(a.gst, 500); assert.equal(a.pst, 700); assert.equal(a.total, 11200); assert.equal(a.tax_auto, true);

  // description defaults to the category when blank; per-receipt province override
  const b = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-02', vendor: 'Pub', category: 'Meals', province: 'AB',
    subtotal: 8000, tax_auto: true, tip: 1500, billable: false, image: img(2) })).body;
  assert.equal(b.description, 'Meals');
  assert.equal(b.gst, 400); assert.equal(b.pst, 0); assert.equal(b.province, 'AB');

  // manual taxes (tax_auto off) are kept exactly; later switching tax_auto on recalculates
  const m = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-03', vendor: 'Cafe', category: 'Meals', description: 'Team lunch, "crew"',
    subtotal: 5000, gst: 250, pst: 0, billable: false, image: img(2) })).body;
  assert.equal(m.gst, 250);
  assert.equal(m.tax_auto, false);
  const m2 = (await c.patch(`/api/receipts/${m.id}`, { province: 'ON', tax_auto: true })).body;
  assert.equal(m2.gst, 650);

  // a receipt saved with no tax at all -> estimated only in reports
  const n = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-04', vendor: 'Shop', description: 'Screws', subtotal: 2000, billable: true })).body;
  assert.equal(n.gst, 0);

  // idempotent offline sync
  assert.equal((await c.post(`/api/projects/${p.id}/receipts`, { client_id: 'abc', subtotal: 1 })).body.id, a.id);

  // numbers never reused
  await c.del(`/api/receipts/${m.id}`);
  const z = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-05', description: 'Z', subtotal: 100 })).body;
  assert.equal(z.number, 5);
  await c.del(`/api/receipts/${z.id}`);

  // validation
  assert.equal((await c.post(`/api/projects/${p.id}/receipts`, { subtotal: -5 })).status, 400);
  assert.equal((await c.post(`/api/projects/${p.id}/receipts`, { image: 'AAAA' })).status, 400);
  assert.equal((await c.post(`/api/projects/${p.id}/receipts`, { province: 'ZZ' })).status, 400);

  // report CSV: estimation on by default (flagged), off with autotax=0
  const csv = (await c.get(`/api/projects/${p.id}/report.csv`)).body.toString();
  assert.match(csv, /^﻿Number,Date,Project,Province,Category,Vendor,Description,Billable,Subtotal,GST\/HST,PST\/QST,Tip,Total,Tax estimated/);
  assert.match(csv, /4,2026-03-04,Deck Build \/ 2026,BC,,Shop,Screws,Billable,20\.00,1\.00,1\.40,0\.00,22\.40,Yes/);
  assert.match(csv, /1,2026-03-01,Deck Build \/ 2026,BC,Materials,Home Depot,Lumber for deck,Billable,100\.00,5\.00,7\.00,0\.00,112\.00,,/);
  const raw = (await c.get(`/api/projects/${p.id}/report.csv?autotax=0`)).body.toString();
  assert.match(raw, /4,2026-03-04,Deck Build \/ 2026,BC,,Shop,Screws,Billable,20\.00,0\.00,0\.00,0\.00,20\.00,,/);
  assert.equal((await c.get(`/api/projects/${p.id}/report.csv?from=2026-03-04`)).body.toString().trim().split('\r\n').length, 2);

  // zip bundle: pdf + csv + named jpgs
  const zipRes = await c.get(`/api/projects/${p.id}/export.zip`);
  assert.equal(zipRes.status, 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-zip-'));
  fs.writeFileSync(path.join(dir, 'x.zip'), zipRes.body);
  const listing = execFileSync('unzip', ['-Z1', path.join(dir, 'x.zip')]).toString().trim().split('\n').sort();
  assert.deepEqual(listing, [
    'Deck-Build-2026_receipts/receipts/001_Lumber-for-deck.jpg',
    'Deck-Build-2026_receipts/receipts/002_Meals.jpg',
    'Deck-Build-2026_receipts/report.csv',
    'Deck-Build-2026_receipts/report.pdf',
  ]);
  execFileSync('unzip', ['-q', path.join(dir, 'x.zip'), '-d', dir]);
  const pdf = path.join(dir, 'Deck-Build-2026_receipts/report.pdf');
  const text = execFileSync('pdftotext', ['-layout', pdf, '-']).toString();
  assert.match(text, /Billable \(2\)/);
  assert.match(text, /Non-billable \(1\)/);
  assert.match(text, /Materials/);
  assert.match(text, /\$1\.00\*/);                      // estimated GST is starred
  assert.match(text, /estimated from the receipt province/);
  assert.match(execFileSync('pdfimages', ['-list', pdf]).toString(), /jpeg/);
  if (process.env.KEEP_PDF) fs.copyFileSync(pdf, process.env.KEEP_PDF);

  // image served; deleting the project removes its files
  assert.equal((await c.get(`/api/receipts/${a.id}/image`)).status, 200);
  await c.del(`/api/projects/${p.id}`);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'images')).length, 0);
});

test('household items: warranty fields, listing, csv, image, validation', async () => {
  const c = await adminClient();
  const tv = (await c.post('/api/items', { client_id: 'tv1', name: 'Living-room TV', category: 'Electronics', purchase_date: '2025-06-30',
    vendor: 'Best Buy', price: 129999, warranty_months: 24, serial: 'QN90D-123', image: img(1) })).body;
  assert.equal(tv.warranty_expires, '2027-06-30');
  assert.equal(tv.has_image, true);
  assert.equal((await c.post('/api/items', { client_id: 'tv1', name: 'dup', purchase_date: '2025-06-30' })).body.id, tv.id);

  const toaster = (await c.post('/api/items', { name: 'Toaster', purchase_date: '2024-01-31' })).body; // warranty unknown
  assert.equal(toaster.warranty_expires, null);
  assert.equal((await c.patch(`/api/items/${toaster.id}`, { warranty_months: 1 })).body.warranty_expires, '2024-02-29');

  assert.equal((await c.post('/api/items', { name: '', purchase_date: '2025-01-01' })).status, 400);
  assert.equal((await c.post('/api/items', { name: 'x', purchase_date: 'yesterday' })).status, 400);
  assert.equal((await c.post('/api/items', { name: 'x', purchase_date: '2025-01-01', warranty_months: -3 })).status, 400);

  const list = (await c.get('/api/items')).body;
  assert.equal(list.length, 2);
  assert.equal((await c.get(`/api/items/${tv.id}/image`)).status, 200);
  const csv = (await c.get('/api/items.csv')).body.toString();
  assert.match(csv, /Living-room TV,Electronics,2025-06-30,Best Buy,1299\.99,24,2027-06-30,QN90D-123/);

  await c.del(`/api/items/${tv.id}`);
  assert.equal((await c.get(`/api/items/${tv.id}`)).status, 404);
});

test('meta endpoint exposes provinces and categories', async () => {
  const c = await adminClient();
  const m = (await c.get('/api/meta')).body;
  assert.equal(m.provinces.BC.pst, 7000);
  assert.ok(m.receipt_categories.includes('Meals'));
  assert.ok(m.item_categories.includes('Appliance'));
});

test('time zone setting: admin-only, validated, drives server "today"', async () => {
  const { todayStr, setTz } = await import('../server/tz.js');
  setTz('Pacific/Kiritimati');           // UTC+14
  const a = todayStr(new Date('2026-01-01T12:00:00Z')), b = (setTz('Pacific/Pago_Pago'), todayStr(new Date('2026-01-01T12:00:00Z')));
  assert.equal(a, '2026-01-02'); assert.equal(b, '2026-01-01');
  setTz('UTC');
  const c = await adminClient();
  assert.equal((await c.put('/api/general', { timezone: 'Nope/Zone' })).status, 400);
  const ok = await c.put('/api/general', { timezone: 'America/Vancouver' });
  assert.equal(ok.status, 200); assert.equal((await c.get('/api/general')).body.timezone, 'America/Vancouver');
  setTz('UTC');
});
