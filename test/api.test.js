import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-test-'));
const { createApp } = await import('../server/index.js');

let server, base;
before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
};
const img = (n) => 'data:image/jpeg;base64,' + fs.readFileSync(new URL(`./fixtures/r${n}.jpg`, import.meta.url)).toString('base64');

test('full flow: project, receipts, totals, exports', async () => {
  const p = (await api('POST', '/api/projects', { name: 'Deck Build / 2026', client: 'ACME' })).body;
  assert.equal(p.gst_rate, 5);

  const a = await api('POST', `/api/projects/${p.id}/receipts`, { client_id: 'abc', date: '2026-03-01', vendor: 'Home Depot',
    description: 'Lumber for deck', subtotal: 10000, gst: 500, pst: 700, tip: 0, billable: true, image: img(1) });
  assert.equal(a.status, 201);
  assert.equal(a.body.number, 1);
  assert.equal(a.body.total, 11200);

  // retried offline sync must not duplicate
  const dup = await api('POST', `/api/projects/${p.id}/receipts`, { client_id: 'abc', date: '2026-03-01', subtotal: 1 });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.id, a.body.id);

  const b = await api('POST', `/api/projects/${p.id}/receipts`, { date: '2026-03-02', vendor: 'Pub', description: 'Team lunch: "crew"',
    subtotal: 8000, gst: 400, pst: 0, tip: 1500, billable: false, image: img(2) });
  assert.equal(b.body.number, 2);

  // numbers are never reused after delete
  await api('DELETE', `/api/receipts/${b.body.id}`);
  const c = await api('POST', `/api/projects/${p.id}/receipts`, { date: '2026-03-03', vendor: 'Pub', description: 'Team lunch, "crew"',
    subtotal: 8000, gst: 400, tip: 1500, billable: false, image: img(2) });
  assert.equal(c.body.number, 3);

  const detail = (await api('GET', `/api/projects/${p.id}`)).body;
  assert.equal(detail.billable.total, 11200);
  assert.equal(detail.non_billable.total, 9900);
  assert.equal(detail.non_billable.tip, 1500);

  // validation
  assert.equal((await api('POST', `/api/projects/${p.id}/receipts`, { subtotal: -5 })).status, 400);
  assert.equal((await api('POST', `/api/projects/${p.id}/receipts`, { image: 'AAAA' })).status, 400);
  assert.equal((await api('POST', `/api/projects/${p.id}/receipts`, { date: 'nope' })).status, 400);

  // exports
  const zipRes = await api('GET', `/api/projects/${p.id}/export.zip`);
  assert.equal(zipRes.status, 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-zip-'));
  fs.writeFileSync(path.join(dir, 'x.zip'), zipRes.body);
  const listing = execFileSync('unzip', ['-Z1', path.join(dir, 'x.zip')]).toString().trim().split('\n');
  assert.deepEqual(listing.sort(), [
    'Deck-Build-2026_receipts/receipts/001_Lumber-for-deck.jpg',
    'Deck-Build-2026_receipts/receipts/003_Team-lunch-crew.jpg',
    'Deck-Build-2026_receipts/report.csv',
    'Deck-Build-2026_receipts/report.pdf',
  ]);
  execFileSync('unzip', ['-q', path.join(dir, 'x.zip'), '-d', dir]);
  const csv = fs.readFileSync(path.join(dir, 'Deck-Build-2026_receipts/report.csv'), 'utf8');
  assert.match(csv, /1,2026-03-01,Deck Build \/ 2026,Home Depot,Lumber for deck,Billable,100\.00,5\.00,7\.00,0\.00,112\.00/);
  assert.match(csv, /"Team lunch, ""crew"""/);
  const pdf = path.join(dir, 'Deck-Build-2026_receipts/report.pdf');
  const text = execFileSync('pdftotext', ['-layout', pdf, '-']).toString();
  assert.match(text, /Billable \(1\)/);
  assert.match(text, /Non-billable \(1\)/);
  assert.match(text, /\$112\.00/);
  assert.match(text, /\$99\.00/);
  assert.match(execFileSync('pdfimages', ['-list', pdf]).toString(), /jpeg/);
  fs.copyFileSync(pdf, path.join(process.env.KEEP_PDF || os.tmpdir(), 'rb-sample.pdf'));

  // date filter
  const f = (await api('GET', `/api/projects/${p.id}/report.csv?from=2026-03-03`)).body.toString();
  assert.equal(f.trim().split('\r\n').length, 2);

  // image served; project delete removes files
  assert.equal((await api('GET', `/api/receipts/${a.body.id}/image`)).status, 200);
  await api('DELETE', `/api/projects/${p.id}`);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'images')).length, 0);
});
