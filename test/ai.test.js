import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { DatabaseSync } from 'node:sqlite';
import { start, stop, client, adminClient, img } from './helper.js';
import { checkIdle, compareReceipt, rulesCheck, extractJson, sanitizeFilters, normalizeRead } from '../server/ai.js';
import { createBackup } from '../server/backup.js';

// ---- a stand-in for Ollama / LM Studio: OpenAI-compatible, records every request
const llm = { calls: [], handler: () => '{}', status: 200 };
let llmServer, llmBase;
before(async () => {
  await start();
  llmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake-vl' }, { id: 'other' }] }));
      const json = JSON.parse(body || '{}');
      llm.calls.push({ url: req.url, auth: req.headers.authorization, body: json });
      if (llm.status !== 200) { res.statusCode = llm.status; return res.end('model exploded'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: llm.handler(json) } }] }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => llmServer.once('listening', r));
  llmBase = `http://127.0.0.1:${llmServer.address().port}/v1`;
});
after(() => { stop(); llmServer.close(); });

const read = (o) => JSON.stringify({ vendor: 'Home Depot', date: '2026-03-14', subtotal: 84.75, gst_hst: 4.24, pst_qst: 5.93, tip: null, total: 94.92, notes: '', ...o });
test.beforeEach(() => { llm.status = 200; });
const setAi = (c, o = {}) => c.put('/api/ai', { enabled: true, base_url: llmBase, model: 'fake-vl', vision: true, auto_check: true, timeout_s: 20, ...o });
const entry = { date: '2026-03-14', vendor: 'Home Depot', description: 'Lumber', subtotal: 8475, gst: 424, pst: 593, billable: true, allow_duplicate: true };

test('pure helpers: JSON extraction, comparison, rules, filter sanitising', () => {
  assert.deepEqual(extractJson('<think>hmm {not json}</think>\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.throws(() => extractJson('no json here'), /did not return JSON/);
  assert.throws(() => extractJson('{"a": '), /did not return JSON|malformed/);
  assert.deepEqual(normalizeRead({ vendor: 'X', date: 'nope', subtotal: '$1,234.50', gst_hst: '5', pst_qst: null, tip: 'abc', total: 12 }),
    { vendor: 'X', date: null, subtotal: 123450, gst: 500, pst: null, tip: null, total: 1200, notes: '' });

  const r = { date: '2026-03-14', vendor: 'Home Depot', subtotal: 8745, gst: 424, pst: 593, tip: 0, province: 'BC', tax_auto: 0 };
  const same = { vendor: 'HOME DEPOT #7011', date: '2026-03-14', subtotal: 8745, gst: 424, pst: 593, tip: null, total: 9762 };
  assert.deepEqual(compareReceipt(r, same), []);                                            // same data: no issues, vendor variants fine
  const issues = compareReceipt(r, { ...same, subtotal: 8475, total: 9492, date: '2026-14-03'.replace('14-03', '03-14') });
  assert.deepEqual(issues.map((i) => i.field), ['subtotal', 'total']);
  assert.equal(issues[0].value, 8475);
  assert.match(issues[0].message, /you entered \$87\.45, the receipt looks like \$84\.75/);
  assert.equal(issues[1].value, null);                                                      // a total can't be "applied" to a single field
  const swapped = compareReceipt({ ...r, date: '2026-03-04' }, { ...same, date: '2026-04-03', subtotal: 8745 });
  assert.match(swapped.find((i) => i.field === 'date').message, /swapped/);
  assert.equal(compareReceipt(r, { ...same, vendor: 'Totally Different Shop' }).find((i) => i.field === 'vendor').severity, 'info');
  assert.equal(compareReceipt(r, { ...same, vendor: 'Home Depot Canada' }).length, 0);       // substring match is not a mismatch
  assert.ok(compareReceipt({ ...r, gst: 0 }, same).some((i) => i.field === 'gst' && /wasn't entered/.test(i.message)));

  assert.ok(rulesCheck({ ...r, date: '2999-01-01' }).some((i) => i.severity === 'warn' && /future/.test(i.message)));
  assert.ok(rulesCheck({ ...r, subtotal: 10000, gst: 900 }).some((i) => i.field === 'gst'));  // 9% GST in BC is not 5%
  assert.equal(rulesCheck({ ...r, subtotal: 10000, gst: 500, pst: 700 }, '2026-06-01').length, 0);
  assert.equal(rulesCheck({ ...r, subtotal: 10000, gst: 900, tax_auto: 1 }).length, 0);        // auto taxes are never second-guessed

  const f = sanitizeFilters({ any: ['TV ', 'television', '', 5], category: 'electronics', vendor: 'Best Buy', from: '2025-12-31', to: '2025-01-01', min: '100', max: 'x', warranty: 'bogus' }, 'items', ['Appliance', 'Electronics']);
  assert.deepEqual(f, { any: ['tv', 'television', '5'], category: 'Electronics', vendor: 'Best Buy', from: '2025-01-01', to: '2025-12-31', min: 10000, max: null, warranty: 'any' });
  assert.equal(sanitizeFilters({ category: 'Invented' }, 'receipts', ['Meals']).category, '');
});

test('settings: admin only, key never returned, validation, status for everyone', async () => {
  const admin = await adminClient();
  assert.equal((await admin.get('/api/ai/status')).body.enabled, false);
  assert.equal((await admin.put('/api/ai', { enabled: true, base_url: 'ftp://nope', model: 'x' })).status, 400);
  const put = await setAi(admin, { api_key: 'sk-secret-123' });
  assert.equal(put.status, 200);
  assert.equal(put.body.has_key, true);
  assert.equal(JSON.stringify(put.body).includes('sk-secret'), false);
  assert.equal(JSON.stringify((await admin.get('/api/ai')).body).includes('sk-secret'), false);
  assert.deepEqual((await admin.get('/api/ai/status')).body, { enabled: true, vision: true, auto_check: true });

  await admin.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  const bob = client(); await bob.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  assert.equal((await bob.get('/api/ai')).status, 403);
  assert.equal((await bob.put('/api/ai', { enabled: false })).status, 403);
  assert.equal((await bob.post('/api/ai/test')).status, 403);
  assert.equal((await bob.get('/api/ai/status')).body.enabled, true);

  // test-connection: sends the key as a bearer token, lists models
  const t = await admin.post('/api/ai/test');
  assert.equal(t.status, 200); assert.equal(t.body.ok, true); assert.deepEqual(t.body.models, ['fake-vl', 'other']);
  assert.equal(llm.calls.at(-1).auth, 'Bearer sk-secret-123');
  await setAi(admin, { base_url: 'http://127.0.0.1:1/v1' });
  const bad = await admin.post('/api/ai/test');
  assert.equal(bad.status, 502); assert.match(bad.body.error, /Can't reach the AI server/);
  await setAi(admin);                                                                       // key kept when blank
  assert.equal((await admin.get('/api/ai')).body.has_key, true);
});

test('backup snapshots never contain the AI key', async () => {
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-aibk-')), 'b.zip');
  await createBackup(dest);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-aibk2-'));
  fs.writeFileSync(path.join(dir, 'x.db'), new AdmZip(dest).getEntry('receipts.db').getData());
  const snap = new DatabaseSync(path.join(dir, 'x.db'));
  assert.equal(snap.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'ai.api_key'").get().n, 0);
  assert.equal(snap.prepare("SELECT value FROM settings WHERE key = 'ai.model'").get().value, 'fake-vl');   // other AI settings are kept
  snap.close();
});

test('vision mode: model blind-reads the photo; matching entry is ok, a typo is flagged with a one-tap fix', async () => {
  const c = await adminClient();
  await setAi(c);
  const p = (await c.post('/api/projects', { name: 'Check me', province: 'BC' })).body;

  llm.calls.length = 0; llm.handler = () => read();
  const good = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, image: img(1) })).body;
  assert.equal(good.check.status, 'pending');
  await checkIdle();
  const ok = (await c.get(`/api/receipts/${good.id}`)).body;
  assert.equal(ok.check.status, 'ok'); assert.equal(ok.check.mode, 'image'); assert.deepEqual(ok.check.issues, []);

  // what the model was shown: the photo, and NOT the values that were typed in
  const sent = llm.calls[0].body;
  assert.equal(sent.temperature, 0);
  const content = sent.messages.at(-1).content;
  assert.equal(content[1].type, 'image_url'); assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(JSON.stringify(sent.messages).includes('84.75') || JSON.stringify(sent.messages).includes('8475'), false);

  // fat-fingered subtotal: 87.45 typed, 84.75 on the receipt
  const typo = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, subtotal: 8745, vendor: 'Home Depot ', description: 'Typo', image: img(2) })).body;
  await checkIdle();
  const bad = (await c.get(`/api/receipts/${typo.id}`)).body;
  assert.equal(bad.check.status, 'review');
  const fromAi = bad.check.issues.filter((i) => i.source === 'ai');
  assert.deepEqual(fromAi.map((i) => i.field), ['subtotal', 'total']);
  assert.equal(fromAi[0].value, 8475);
  // and the rules check independently notices that the taxes don't fit the mistyped subtotal
  assert.deepEqual(bad.check.issues.filter((i) => i.source === 'rules').map((i) => i.field), ['gst', 'pst']);

  // fixing the entry re-checks automatically; dismissing keeps a record of the review
  await c.patch(`/api/receipts/${typo.id}`, { subtotal: 8475 });
  assert.ok(['pending', 'ok'].includes((await c.get(`/api/receipts/${typo.id}`)).body.check.status)); // re-queued (fast stand-in may already be done)
  await checkIdle();
  assert.equal((await c.get(`/api/receipts/${typo.id}`)).body.check.status, 'ok');
  await c.patch(`/api/receipts/${typo.id}`, { notes: 'just a note' });                       // unrelated edit: no re-check
  assert.equal((await c.get(`/api/receipts/${typo.id}`)).body.check.status, 'ok');
  llm.handler = () => read({ total: 99.99 });
  assert.equal((await c.post(`/api/receipts/${typo.id}/check`)).status, 202);
  await checkIdle();
  assert.equal((await c.get(`/api/receipts/${typo.id}`)).body.check.status, 'review');
  assert.equal((await c.post(`/api/receipts/${typo.id}/check/dismiss`)).status, 204);
  assert.equal((await c.get(`/api/receipts/${typo.id}`)).body.check.status, 'reviewed');

  // ocr_text / check blobs are not leaked in list payloads
  const detail = (await c.get(`/api/projects/${p.id}`)).body.receipts[0];
  assert.equal('ocr_text' in detail, false); assert.equal('check_json' in detail, false);
});

test('text mode (no vision): OCR text is sent instead of the photo', async () => {
  const c = await adminClient();
  await setAi(c, { vision: false });
  const p = (await c.post('/api/projects', { name: 'Text mode' })).body;
  llm.calls.length = 0; llm.handler = () => '<think>reading…</think>' + read();
  const r = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, image: img(1), ocr_text: 'HOME DEPOT\nSUBTOTAL 84.75\nTOTAL 94.92' })).body;
  await checkIdle();
  assert.equal((await c.get(`/api/receipts/${r.id}`)).body.check.mode, 'text');
  const sent = llm.calls[0].body.messages.at(-1).content;
  assert.equal(typeof sent, 'string'); assert.match(sent, /SUBTOTAL 84\.75/);
  assert.equal(JSON.stringify(llm.calls[0].body).includes('base64'), false);

  // photo but no text and a text-only model: a clear explanation, not a crash
  const lone = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, description: 'No text', subtotal: 1111, image: img(1) })).body;
  await checkIdle();
  const e = (await c.get(`/api/receipts/${lone.id}`)).body.check;
  assert.equal(e.status, 'error'); assert.match(e.error, /model can read images/);
});

test('failures are reported on the receipt, never thrown; auto-check can be switched off', async () => {
  const c = await adminClient();
  await setAi(c);
  const p = (await c.post('/api/projects', { name: 'Failures' })).body;
  llm.status = 500;
  const r = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, description: 'Boom', image: img(1) })).body;
  assert.equal(r.id > 0, true);                                                             // saving was not blocked
  await checkIdle();
  llm.status = 200;
  const bad = (await c.get(`/api/receipts/${r.id}`)).body.check;
  assert.equal(bad.status, 'error'); assert.match(bad.error, /500/);

  llm.handler = () => 'sorry, I cannot help with that';
  await c.post(`/api/receipts/${r.id}/check`); await checkIdle();
  assert.match((await c.get(`/api/receipts/${r.id}`)).body.check.error, /did not return JSON/);

  await setAi(c, { auto_check: false });
  const quiet = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, description: 'Quiet', subtotal: 2222, image: img(2) })).body;
  assert.equal(quiet.check.status, 'none');
  await setAi(c, { enabled: false });
  assert.equal((await c.post(`/api/receipts/${quiet.id}/check`)).status, 400);
  await setAi(c);
});

test('smart search: a sentence becomes sanitised filters (and only for logged-in users)', async () => {
  const c = await adminClient();
  await setAi(c);
  await c.post('/api/items', { name: 'Samsung fridge', category: 'Appliance', purchase_date: '2025-02-01', vendor: 'Home Depot', price: 129900, warranty_months: 24 });
  llm.calls.length = 0;
  llm.handler = () => '```json\n' + JSON.stringify({ any: ['fridge', 'refrigerator'], category: 'appliance', vendor: 'Home Depot', from: '2025-01-01', to: '2025-12-31', min: null, max: 2000, warranty: 'active', evil: '<script>' }) + '\n```';
  const r = await c.post('/api/ai/search', { query: 'the fridge from Home Depot last year under $2000', scope: 'items' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.filters, { any: ['fridge', 'refrigerator'], category: 'Appliance', vendor: 'Home Depot', from: '2025-01-01', to: '2025-12-31', min: null, max: 200000, warranty: 'active' });
  const prompt = llm.calls[0].body.messages.at(-1).content;
  assert.match(prompt, /Today is \d{4}-\d{2}-\d{2}/);
  assert.match(prompt, /Appliance/); assert.match(prompt, /Home Depot/);                      // grounded in real categories + vendors

  assert.equal((await c.post('/api/ai/search', { query: '', scope: 'items' })).status, 400);
  llm.handler = () => 'no';
  assert.equal((await c.post('/api/ai/search', { query: 'x', scope: 'items' })).status, 502);
  assert.equal((await client().post('/api/ai/search', { query: 'x' })).status, 401);
});

test('multi-photo receipts send every page; drafts are not checked until reviewed', async () => {
  const c = await adminClient();
  await setAi(c);
  const p = (await c.post('/api/projects', { name: 'Pages' })).body;
  llm.calls.length = 0; llm.handler = () => read();
  const multi = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, description: 'Two pages', subtotal: 8475, images: [img(1), img(2)] })).body;
  await checkIdle();
  const parts = llm.calls[0].body.messages.at(-1).content;
  assert.deepEqual(parts.map((x) => x.type), ['text', 'image_url', 'image_url']);
  assert.match(parts[0].text, /2 photos/);
  assert.equal((await c.get(`/api/receipts/${multi.id}`)).body.check.status, 'ok');

  llm.calls.length = 0;
  const draft = (await c.post(`/api/projects/${p.id}/receipts`, { ...entry, description: 'Draft', subtotal: 5555, draft: true, images: [img(1)] })).body;
  await checkIdle();
  assert.equal(llm.calls.length, 0); assert.equal(draft.check.status, 'none');           // nothing sent to the model for a draft
  const fin = (await c.patch(`/api/receipts/${draft.id}`, { draft: false })).body;
  assert.equal(fin.check.status, 'pending');                                                // reviewing it queues the check
  await checkIdle();
  assert.equal(llm.calls.length, 1);
});
