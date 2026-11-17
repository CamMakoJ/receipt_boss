import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { start, stop, client, adminClient, img, DATA_DIR } from './helper.js';

before(start); after(stop);
const imgDir = path.join(DATA_DIR, 'images');
const fileCount = () => fs.readdirSync(imgDir).length;
const bytes = async (c, url) => (await c.get(url)).body;

test('receipts: several photos, cover, add / remove / reorder, limits, bad input', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Photos' })).body;
  const base = { date: '2026-03-01', vendor: 'Shop', description: 'Long receipt', subtotal: 1000 };

  const r = (await c.post(`/api/projects/${p.id}/receipts`, { ...base, images: [img(1), img(2), img(1)] })).body;
  assert.equal(r.photos.length, 3); assert.equal(r.has_image, true);
  assert.equal(fileCount(), 3);
  const [a, b, d] = r.photos;
  assert.deepEqual(await bytes(c, `/api/receipts/${r.id}/image`), await bytes(c, `/api/receipts/${r.id}/photos/${a}`));   // cover = first
  assert.notDeepEqual(await bytes(c, `/api/receipts/${r.id}/photos/${a}`), await bytes(c, `/api/receipts/${r.id}/photos/${b}`));

  // add + remove + make another photo the cover
  const up = (await c.patch(`/api/receipts/${r.id}`, { add_images: [img(2)], remove_photo_ids: [d], photo_order: [b, a] })).body;
  assert.equal(up.photos.length, 3);
  assert.deepEqual(up.photos.slice(0, 2), [b, a]);                                          // reordered; the new photo goes last
  assert.deepEqual(await bytes(c, `/api/receipts/${r.id}/image`), await bytes(c, `/api/receipts/${r.id}/photos/${b}`));
  assert.equal(fileCount(), 3);                                                             // removed file is gone from disk
  assert.equal((await c.get(`/api/receipts/${r.id}/photos/${d}`)).status, 404);
  assert.equal((await c.patch(`/api/receipts/${r.id}`, { notes: 'x' })).body.photos.length, 3);   // unrelated edit leaves photos alone

  // bad image: rejected, nothing half-saved
  const before = fileCount();
  assert.equal((await c.patch(`/api/receipts/${r.id}`, { add_images: [img(1), 'AAAA'] })).status, 400);
  assert.equal(fileCount(), before);
  assert.equal((await c.get(`/api/receipts/${r.id}`)).body.photos.length, 3);

  // limit of 12
  const many = Array.from({ length: 10 }, () => img(1));
  assert.equal((await c.patch(`/api/receipts/${r.id}`, { add_images: many })).status, 400);   // 3 + 10 > 12
  assert.equal((await c.patch(`/api/receipts/${r.id}`, { add_images: many.slice(0, 9) })).body.photos.length, 12);

  // legacy single-image API still works: `image` replaces everything, `remove_image` clears
  const legacy = (await c.patch(`/api/receipts/${r.id}`, { image: img(2) })).body;
  assert.equal(legacy.photos.length, 1); assert.equal(fileCount(), 1);
  const none = (await c.patch(`/api/receipts/${r.id}`, { remove_image: true })).body;
  assert.deepEqual([none.photos.length, none.has_image, fileCount()], [0, false, 0]);

  // another user can't read photos, and ids from other receipts don't leak through
  const r2 = (await c.post(`/api/projects/${p.id}/receipts`, { ...base, description: 'Other', subtotal: 5, images: [img(1)] })).body;
  const r3 = (await c.post(`/api/projects/${p.id}/receipts`, { ...base, description: 'Third', subtotal: 6 })).body;
  assert.equal((await c.get(`/api/receipts/${r3.id}/photos/${r2.photos[0]}`)).status, 404);
  assert.equal((await c.patch(`/api/receipts/${r3.id}`, { remove_photo_ids: [r2.photos[0]] })).status, 200);
  assert.equal((await c.get(`/api/receipts/${r2.id}`)).body.photos.length, 1);              // not removed from the other receipt
  await c.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  const bob = client(); await bob.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  assert.equal((await bob.get(`/api/receipts/${r2.id}/photos/${r2.photos[0]}`)).status, 404);

  // list endpoints carry photo ids too
  assert.deepEqual((await c.get(`/api/projects/${p.id}`)).body.receipts.find((x) => x.id === r2.id).photos, r2.photos);
});

test('deleting receipts, projects, users and items removes every photo file', async () => {
  const c = await adminClient();
  const start = fileCount();
  const p = (await c.post('/api/projects', { name: 'Cleanup' })).body;
  const r = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-01', vendor: 'A', subtotal: 1, images: [img(1), img(2)] })).body;
  await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-02', vendor: 'B', subtotal: 2, images: [img(1), img(2), img(1)] });
  assert.equal(fileCount(), start + 5);
  await c.del(`/api/receipts/${r.id}`); assert.equal(fileCount(), start + 3);
  await c.del(`/api/projects/${p.id}`); assert.equal(fileCount(), start);

  const it = (await c.post('/api/items', { name: 'Fridge', purchase_date: '2025-01-01', images: [img(1), img(2)] })).body;
  assert.equal(it.photos.length, 2); assert.equal(fileCount(), start + 2);
  const it2 = (await c.patch(`/api/items/${it.id}`, { remove_photo_ids: [it.photos[0]], add_images: [img(1)] })).body;
  assert.equal(it2.photos.length, 2); assert.equal(fileCount(), start + 2);
  assert.equal((await c.get('/api/items')).body.find((x) => x.id === it.id).photos.length, 2);
  assert.equal((await c.get(`/api/items/${it.id}/photos/${it2.photos[1]}`)).status, 200);
  assert.equal((await c.get(`/api/items/${it.id}/photos/999999`)).status, 404);
  await c.del(`/api/items/${it.id}`); assert.equal(fileCount(), start);

  // deleting a user removes their receipts' photos
  const u = (await c.post('/api/users', { username: 'temp', password: 'temp-password-1' })).body;
  const t = client(); await t.post('/api/auth/login', { username: 'temp', password: 'temp-password-1' });
  const tp = (await t.post('/api/projects', { name: 'T' })).body;
  await t.post(`/api/projects/${tp.id}/receipts`, { date: '2026-03-02', vendor: 'B', subtotal: 2, images: [img(1), img(2)] });
  assert.equal(fileCount(), start + 2);
  assert.equal((await c.del(`/api/users/${u.id}`)).status, 204); assert.equal(fileCount(), start);
});

test('exports include every photo: zip names, PDF pages, CSV column', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Multi' })).body;
  await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-01', vendor: 'Shop', description: 'Two pages', subtotal: 1111, images: [img(1), img(2)] });
  await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-02', vendor: 'Shop', description: 'One page', subtotal: 2222, images: [img(1)] });
  await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-03', vendor: 'Shop', description: 'No photo', subtotal: 3333 });

  const zip = (await c.get(`/api/projects/${p.id}/export.zip`)).body;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mp-'));
  fs.writeFileSync(path.join(dir, 'x.zip'), zip);
  const names = execFileSync('unzip', ['-Z1', path.join(dir, 'x.zip')]).toString().trim().split('\n').map((n) => n.split('/').slice(1).join('/')).sort();
  assert.deepEqual(names, ['receipts/001_Two-pages.jpg', 'receipts/001_Two-pages_2.jpg', 'receipts/002_One-page.jpg', 'report.csv', 'report.pdf']);

  execFileSync('unzip', ['-q', path.join(dir, 'x.zip'), '-d', dir]);
  const sub = fs.readdirSync(dir).find((d) => d.endsWith('_receipts'));
  const pdf = path.join(dir, sub, 'report.pdf');
  assert.match(execFileSync('pdfinfo', [pdf]).toString(), /Pages:\s+5/);                      // summary + 2 + 1 + "no image" page
  const text = execFileSync('pdftotext', ['-layout', pdf, '-']).toString();
  assert.match(text, /\(photo 1 of 2\)/); assert.match(text, /\(photo 2 of 2\)/); assert.match(text, /no image attached/);
  assert.equal(execFileSync('pdfimages', ['-list', pdf]).toString().trim().split('\n').length - 2, 3);   // 3 embedded images

  const csv = (await c.get(`/api/projects/${p.id}/report.csv`)).body.toString();
  assert.match(csv, /receipts\/001_Two-pages\.jpg; receipts\/001_Two-pages_2\.jpg/);
});

test('migration: a v3 database (single image per receipt/item) is upgraded to v5 with photo rows and indexes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mig-'));
  const dbPath = path.join(dir, 'receipts.db');
  // build a v4 database with the normal code, then rewind it to what v3 looked like
  const build = `import('${new URL('../server/db.js', import.meta.url).href}').then(({ db }) => {
    db.exec("INSERT INTO users (username, password_hash) VALUES ('u','x'); INSERT INTO projects (user_id, name) VALUES (1,'P');");
    db.exec("INSERT INTO receipts (project_id, number, date, image) VALUES (1,1,'2026-01-01','a.jpg'), (1,2,'2026-01-02',NULL);");
    db.exec("INSERT INTO items (name, purchase_date, image) VALUES ('Fridge','2025-01-01','b.jpg');");
    db.exec('DROP INDEX idx_receipts_project_draft; DROP TABLE receipt_photos; DROP TABLE item_photos; ALTER TABLE receipts DROP COLUMN draft; PRAGMA user_version = 3;'); db.close();
  });`;
  execFileSync('node', ['--no-warnings', '-e', build], { env: { ...process.env, DATA_DIR: dir } });
  const check = `import('${new URL('../server/db.js', import.meta.url).href}').then(({ db }) => {
    console.log(JSON.stringify({ v: db.prepare('PRAGMA user_version').get().user_version,
      rp: db.prepare('SELECT receipt_id, file, position FROM receipt_photos').all(), ip: db.prepare('SELECT item_id, file FROM item_photos').all(),
      draft: db.prepare('SELECT draft FROM receipts').all().map((r) => r.draft),
      indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name) }));
  });`;
  const out = JSON.parse(execFileSync('node', ['--no-warnings', '-e', check], { env: { ...process.env, DATA_DIR: dir } }).toString());
  assert.equal(out.v, 5);
  assert.deepEqual(out.rp.map((r) => ({ ...r })), [{ receipt_id: 1, file: 'a.jpg', position: 0 }]);
  assert.deepEqual(out.ip.map((r) => ({ ...r })), [{ item_id: 1, file: 'b.jpg' }]);
  assert.deepEqual(out.draft, [0, 0]);
  assert.ok(out.indexes.includes('idx_receipts_project_draft') && out.indexes.includes('idx_sessions_expires'));
});

test('adding a page appends its scanned text instead of replacing the earlier text', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Text' })).body;
  const r = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-02-01', vendor: 'T', subtotal: 9999, ocr_text: 'PAGE ONE', images: [img(1)] })).body;
  await c.patch(`/api/receipts/${r.id}`, { add_images: [img(2)], ocr_append: 'PAGE TWO' });
  const all = (await c.get('/api/receipts')).body.find((x) => x.id === r.id);
  assert.equal(all.ocr_text, 'PAGE ONE\n\nPAGE TWO');
  const it = (await c.post('/api/items', { name: 'Thing', purchase_date: '2025-02-02', price: 7, ocr_text: 'A' })).body;
  await c.patch(`/api/items/${it.id}`, { ocr_append: 'B' });
  assert.equal((await c.get('/api/items')).body.find((x) => x.id === it.id).ocr_text, 'A\n\nB');
});
