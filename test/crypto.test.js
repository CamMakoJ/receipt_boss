import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { start, stop, client, adminClient, img, DATA_DIR, zipNames, zipRead } from './helper.js';
import { listEntries } from '../server/zip.js';
import { encryptFile, decryptFile, looksEncrypted } from '../server/crypto-backup.js';

before(start); after(stop);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-crypto-'));
const PASS = 'correct horse battery staple';

test('file encryption: round trip, nothing readable, wrong passphrase / tampering / truncation all detected', async () => {
  const plain = path.join(tmp, 'plain.bin'), enc = path.join(tmp, 'plain.bin.enc'), back = path.join(tmp, 'back.bin');
  const data = crypto.randomBytes(3 * 1024 * 1024 + 123);                       // multi-chunk + odd size
  data.write('SECRET-MARKER-12345', 1000);
  fs.writeFileSync(plain, data);

  await encryptFile(plain, enc, PASS);
  assert.equal(looksEncrypted(enc), true); assert.equal(looksEncrypted(plain), false);
  const raw = fs.readFileSync(enc);
  assert.equal(raw.length, data.length + 8 + 16 + 12 + 16);                       // header + ciphertext + tag
  assert.equal(raw.includes('SECRET-MARKER-12345'), false);

  await decryptFile(enc, back, PASS);
  assert.ok(fs.readFileSync(back).equals(data));
  await decryptFile(enc, null, PASS);                                              // verify-only mode

  // same input, new random salt/iv every time
  const enc2 = path.join(tmp, 'again.enc'); await encryptFile(plain, enc2, PASS);
  assert.ok(!fs.readFileSync(enc2).equals(raw));

  const bad = path.join(tmp, 'bad.bin');
  await assert.rejects(decryptFile(enc, bad, 'wrong passphrase!'), /wrong passphrase, or the backup file is damaged/);
  assert.equal(fs.existsSync(bad), false);                                         // no partial plaintext left behind

  const flipped = Buffer.from(raw); flipped[5000] ^= 1; fs.writeFileSync(path.join(tmp, 'flip.enc'), flipped);
  await assert.rejects(decryptFile(path.join(tmp, 'flip.enc'), bad, PASS), /damaged/);
  const header = Buffer.from(raw); header[12] ^= 1; fs.writeFileSync(path.join(tmp, 'hdr.enc'), header);   // salt is authenticated too
  await assert.rejects(decryptFile(path.join(tmp, 'hdr.enc'), bad, PASS), /damaged/);
  fs.writeFileSync(path.join(tmp, 'cut.enc'), raw.subarray(0, raw.length - 1000));
  await assert.rejects(decryptFile(path.join(tmp, 'cut.enc'), bad, PASS), /damaged/);
  await assert.rejects(decryptFile(plain, bad, PASS), /not an encrypted Receipt Boss backup/);
  fs.writeFileSync(path.join(tmp, 'tiny.enc'), 'x');
  await assert.rejects(decryptFile(path.join(tmp, 'tiny.enc'), bad, PASS), /too small/);

  // empty payload
  fs.writeFileSync(path.join(tmp, 'empty'), ''); await encryptFile(path.join(tmp, 'empty'), path.join(tmp, 'empty.enc'), PASS);
  await decryptFile(path.join(tmp, 'empty.enc'), path.join(tmp, 'empty.out'), PASS);
  assert.equal(fs.readFileSync(path.join(tmp, 'empty.out')).length, 0);
});

test('encrypted backups: settings, run, verify, download, passphrase never leaks, restore script', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'Secret project' })).body;
  await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-01', vendor: 'Shop', description: 'Private purchase', subtotal: 4242, images: [img(1), img(2)] });
  const cfg = { enabled: true, interval_hours: 24, keep: 3, remote: '', copy_dir: '' };

  // validation
  assert.equal((await c.put('/api/backup', { ...cfg, encrypt: true })).status, 400);                         // needs a passphrase
  assert.equal((await c.put('/api/backup', { ...cfg, encrypt: true, passphrase: 'short' })).status, 400);
  const ok = await c.put('/api/backup', { ...cfg, encrypt: true, passphrase: PASS });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.config.encrypt, true); assert.equal(ok.body.config.has_passphrase, true);
  assert.equal(JSON.stringify(ok.body).includes(PASS), false);                                                // write-only
  assert.equal(JSON.stringify((await c.get('/api/backup')).body).includes(PASS), false);

  // run: file is .zip.enc, unreadable as a zip, decrypts to a real backup whose DB lacks the passphrase
  const run = await c.post('/api/backup/run');
  assert.equal(run.status, 200, JSON.stringify(run.body)); assert.match(run.body.message, /\(encrypted\)/);
  const name = run.body.files[0].name; assert.match(name, /\.zip\.enc$/);
  const file = path.join(DATA_DIR, 'backups', name);
  await assert.rejects(listEntries(file));                                                                    // not a zip: it's ciphertext
  assert.equal(fs.readFileSync(file).includes('Private purchase'), false);
  const zipOut = path.join(tmp, 'dec.zip'); await decryptFile(file, zipOut, PASS);
  const names = await zipNames(zipOut);
  assert.ok(names.includes('receipts.db') && names.filter((n) => n.startsWith('images/') && n.length > 7).length === 2);
  fs.writeFileSync(path.join(tmp, 'snap.db'), await zipRead(zipOut, 'receipts.db'));
  const snap = new DatabaseSync(path.join(tmp, 'snap.db'));
  assert.equal(snap.prepare("SELECT COUNT(*) n FROM settings WHERE key IN ('backup.passphrase','ai.api_key')").get().n, 0);
  assert.equal(snap.prepare('SELECT COUNT(*) n FROM receipt_photos').get().n, 2);
  snap.close();

  // verify: right passphrase ok, wrong one refused
  const ver = (await c.post('/api/backup/verify', { passphrase: PASS })).body;
  assert.deepEqual([ver.ok, ver.name, ver.info.encrypted, ver.info.counts.receipts, ver.info.images], [true, name, true, 1, 2]);
  const wrong = await c.post('/api/backup/verify', { passphrase: 'not the passphrase' });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error, /wrong passphrase/);

  // download is encrypted too
  const dl = await c.get('/api/backup/download');
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /\.zip\.enc/);
  assert.equal(dl.body.subarray(0, 5).toString(), 'RBENC');

  // restore script: needs the passphrase, then restores everything
  const fresh = path.join(tmp, 'restored');
  const bare = spawnSync('node', ['--no-warnings', 'scripts/restore.js', file], { env: { ...process.env, DATA_DIR: fresh, RB_BACKUP_PASSPHRASE: '' }, encoding: 'utf8', input: '' });
  assert.notEqual(bare.status, 0); assert.match(bare.stderr, /encrypted/);
  const badRun = spawnSync('node', ['--no-warnings', 'scripts/restore.js', file], { env: { ...process.env, DATA_DIR: fresh, RB_BACKUP_PASSPHRASE: 'nope nope nope' }, encoding: 'utf8' });
  assert.notEqual(badRun.status, 0); assert.match(badRun.stderr, /Could not decrypt: wrong passphrase/);
  assert.equal(fs.existsSync(path.join(fresh, 'receipts.db')), false);                                        // nothing touched
  const good = spawnSync('node', ['--no-warnings', 'scripts/restore.js', file], { env: { ...process.env, DATA_DIR: fresh, RB_BACKUP_PASSPHRASE: PASS }, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /Restored the database and 2 photo/);
  const restored = new DatabaseSync(path.join(fresh, 'receipts.db'));
  assert.equal(restored.prepare("SELECT description FROM receipts").get().description, 'Private purchase');
  restored.close();
  assert.equal(fs.readdirSync(path.join(fresh, 'images')).length, 2);

  // turning encryption off gives plain zips again; clearing the passphrase removes it entirely
  await c.put('/api/backup', { ...cfg, encrypt: false });
  await new Promise((r) => setTimeout(r, 1100));
  const plainRun = await c.post('/api/backup/run');
  assert.match(plainRun.body.files[0].name, /\.zip$/); assert.doesNotMatch(plainRun.body.message, /encrypted/);
  const gone = await c.put('/api/backup', { ...cfg, encrypt: true, clear_passphrase: true });
  assert.deepEqual([gone.body.config.encrypt, gone.body.config.has_passphrase], [false, false]);
});

test('only admins can touch backup encryption', async () => {
  const admin = await adminClient();
  await admin.post('/api/users', { username: 'bob', password: 'bobs-password-1' });
  const bob = client(); await bob.post('/api/auth/login', { username: 'bob', password: 'bobs-password-1' });
  assert.equal((await bob.put('/api/backup', { enabled: true, interval_hours: 24, keep: 3, encrypt: true, passphrase: PASS })).status, 403);
  assert.equal((await bob.post('/api/backup/verify', { passphrase: PASS })).status, 403);
});
