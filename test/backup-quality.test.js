import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { start, stop, adminClient, img, DATA_DIR, zipNames, zipRead } from './helper.js';
import { createBackup, runBackup, backupHealth, cleanupTemp, TMP_DIR } from '../server/backup.js';
import { verifyBackup } from '../server/backup-verify.js';
import { buildZip } from '../server/zip.js';
import { encryptFile } from '../server/crypto-backup.js';
import { db, setSetting } from '../server/db.js';
import { pipeline } from 'node:stream/promises';

before(start); after(stop);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-bq-'));
let n = 0;
const tmpName = (ext = '.zip') => path.join(work, `b${++n}${ext}`);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const writeZip = (file, entries) => pipeline(buildZip(entries), fs.createWriteStream(file));
const imageFiles = () => fs.readdirSync(path.join(DATA_DIR, 'images'));

async function seed(c, tag = 'A') {
  const p = (await c.post('/api/projects', { name: `Quality ${tag}` })).body;
  const r = (await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-03-01', vendor: `Shop ${tag}`, subtotal: 1234 + n, images: [img(1), img(2)] })).body;
  const it = (await c.post('/api/items', { name: `Thing ${tag}`, purchase_date: '2025-05-05', price: 9900 + n, images: [img(1)] })).body;
  return { p, r, it };
}

test('manifest describes exactly what is in the backup: referenced photos only, orphans skipped, missing recorded', async () => {
  const c = await adminClient();
  const { r } = await seed(c, 'manifest');
  fs.writeFileSync(path.join(DATA_DIR, 'images', 'orphan-not-in-db.jpg'), 'junk');                       // a file no record refers to
  const gone = db.prepare('SELECT file FROM receipt_photos WHERE receipt_id = ? ORDER BY position LIMIT 1').get(r.id).file;
  fs.rmSync(path.join(DATA_DIR, 'images', gone));                                                          // a referenced file that vanished from disk

  const dest = tmpName();
  const { manifest } = await createBackup(dest);
  assert.equal(manifest.format, 2);
  assert.deepEqual(manifest.missing, [gone]);
  assert.ok(manifest.orphans_skipped >= 1);
  assert.ok(!manifest.images.some((i) => i.name === 'orphan-not-in-db.jpg' || i.name === gone));
  const names = await zipNames(dest);
  assert.ok(names.includes('manifest.json') && names.includes('receipts.db'));
  assert.ok(!names.includes('images/orphan-not-in-db.jpg'));
  assert.equal(names.filter((x) => x.startsWith('images/')).length, manifest.images.length);

  const disk = JSON.parse((await zipRead(dest, 'manifest.json')).toString());
  assert.deepEqual(disk.counts, manifest.counts);
  assert.equal(disk.db_sha256, sha(await zipRead(dest, 'receipts.db')));                                  // the recorded hash is the real database
  assert.ok(manifest.counts.receipts >= 1 && manifest.counts.items >= 1 && manifest.counts.photos >= 2);

  const v = await verifyBackup(dest);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.match(v.warnings.join(' '), /already missing on the server/);                                    // flagged, not hidden
  assert.equal(fs.readdirSync(TMP_DIR).length, 0);                                                         // no temp leftovers
  await c.del(`/api/receipts/${r.id}`); fs.rmSync(path.join(DATA_DIR, 'images', 'orphan-not-in-db.jpg'));   // leave no dangling references for the other tests
});

test('verification catches damage, tampering, inconsistency and unreadable files', async () => {
  const c = await adminClient();
  await seed(c, 'verify');
  const good = tmpName();
  const { manifest } = await createBackup(good);
  assert.equal((await verifyBackup(good)).ok, true);
  const bytes = fs.readFileSync(good);

  // a flipped bit inside a stored photo -> CRC mismatch
  const at = bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]), bytes.indexOf('images/') + 10) + 200;
  const flipped = Buffer.from(bytes); flipped[at] ^= 0xff;
  const f1 = tmpName(); fs.writeFileSync(f1, flipped);
  const r1 = await verifyBackup(f1); assert.equal(r1.ok, false); assert.match(r1.errors[0], /checksum mismatch|damaged/);

  // truncated download
  const f2 = tmpName(); fs.writeFileSync(f2, bytes.subarray(0, bytes.length - 300));
  assert.equal((await verifyBackup(f2)).ok, false);
  // not a backup at all
  const f3 = tmpName(); fs.writeFileSync(f3, 'hello'); assert.equal((await verifyBackup(f3)).ok, false);

  const dbBuf = await zipRead(good, 'receipts.db'), imgs = [];
  for (const i of manifest.images) imgs.push({ name: `images/${i.name}`, buffer: await zipRead(good, `images/${i.name}`), compress: false });
  const man = (patch) => ({ name: 'manifest.json', buffer: Buffer.from(JSON.stringify({ ...manifest, ...patch })) });

  const f4 = tmpName(); await writeZip(f4, [man({ counts: { ...manifest.counts, receipts: manifest.counts.receipts + 5 } }), { name: 'receipts.db', buffer: dbBuf }, ...imgs]);
  assert.match((await verifyBackup(f4)).errors.join(' '), /manifest says \d+ receipts/);                    // manifest disagrees with the database

  const f5 = tmpName(); await writeZip(f5, [man({ images: [], missing: [] }), { name: 'receipts.db', buffer: dbBuf }]);   // photos silently absent
  assert.match((await verifyBackup(f5)).errors.join(' '), /photo file\(s\) the database refers to are missing/);

  const f6 = tmpName(); await writeZip(f6, [man({}), { name: 'receipts.db', buffer: Buffer.from('this is not a database at all, just text') }]);
  assert.equal((await verifyBackup(f6)).ok, false);

  const f7 = tmpName(); await writeZip(f7, [man({}), ...imgs]);
  assert.match((await verifyBackup(f7)).errors.join(' '), /no receipts\.db/);

  const f8 = tmpName(); await writeZip(f8, [man({}), { name: 'receipts.db', buffer: dbBuf }, ...imgs, { name: 'extra.txt', buffer: Buffer.from('?') }]);
  const r8 = await verifyBackup(f8); assert.equal(r8.ok, true); assert.match(r8.warnings.join(' '), /unexpected file/);   // tolerated, but reported

  // encrypted: needs the passphrase; the wrong one is rejected
  const enc = tmpName('.zip.enc'); await encryptFile(good, enc, 'a long passphrase');
  assert.match((await verifyBackup(enc)).errors[0], /passphrase is needed/);
  assert.match((await verifyBackup(enc, { passphrase: 'nope nope nope' })).errors[0], /wrong passphrase/);
  assert.equal((await verifyBackup(enc, { passphrase: 'a long passphrase' })).ok, true);
});

test('consistent even while the app keeps changing: files deleted mid-backup are still in it, later additions are not', async () => {
  const c = await adminClient();
  const { p, r } = await seed(c, 'concurrent');
  const names = db.prepare('SELECT file FROM receipt_photos WHERE receipt_id = ?').all(r.id).map((x) => x.file);
  assert.equal(names.length, 2);

  const dest = tmpName();
  const pending = createBackup(dest);                                                                      // snapshot is taken immediately...
  await c.del(`/api/receipts/${r.id}`);                                                                    // ...then a receipt and its photos are deleted
  await c.post(`/api/projects/${p.id}/receipts`, { date: '2026-04-01', vendor: 'Added during backup', subtotal: 777, images: [img(2)] });
  for (const f of names) assert.equal(fs.existsSync(path.join(DATA_DIR, 'images', f)), false);              // really gone from disk
  const { manifest } = await pending;

  const inZip = await zipNames(dest);
  for (const f of names) assert.ok(inZip.includes(`images/${f}`), `${f} was in the snapshot and must be in the backup`);
  assert.equal(manifest.missing.length, 0);
  const v = await verifyBackup(dest); assert.equal(v.ok, true, v.errors.join('; '));

  const snap = path.join(work, 'concurrent.db'); fs.writeFileSync(snap, await zipRead(dest, 'receipts.db'));
  const copy = new DatabaseSync(snap);
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM receipts WHERE id = ?").get(r.id).n, 1);              // the receipt still exists in the backup
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM receipts WHERE vendor = 'Added during backup'").get().n, 0);   // the later one does not (matched by name: SQLite reuses the freed row id)
  copy.close();
});

test('writes are atomic and crash leftovers are cleaned up', async () => {
  fs.mkdirSync(path.join(TMP_DIR, 'backup-crashed'), { recursive: true }); fs.writeFileSync(path.join(TMP_DIR, 'backup-crashed', 'x'), '1');
  fs.writeFileSync(path.join(DATA_DIR, 'backups', 'receipt-boss-backup-20200101-000000.zip.partial'), 'half');
  fs.writeFileSync(path.join(DATA_DIR, 'backups', 'receipt-boss-backup-20200102-000000.zip'), 'a real file is left alone');
  cleanupTemp();
  assert.deepEqual(fs.readdirSync(TMP_DIR), []);
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'backups', 'receipt-boss-backup-20200101-000000.zip.partial')));
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'backups', 'receipt-boss-backup-20200102-000000.zip')));
  fs.rmSync(path.join(DATA_DIR, 'backups', 'receipt-boss-backup-20200102-000000.zip'));

  const blocker = tmpName('.txt'); fs.writeFileSync(blocker, 'a file, not a folder');
  await assert.rejects(createBackup(path.join(blocker, 'sub', 'b.zip')));                                   // cannot be created: a failed backup cleans up after itself
  assert.deepEqual(fs.readdirSync(TMP_DIR), []);
  const ok = tmpName(); await createBackup(ok);
  assert.ok(fs.existsSync(ok) && !fs.existsSync(`${ok}.partial`));
});

test('a backup that fails verification is deleted and never counts as a success; history + health tell the truth', async () => {
  const c = await adminClient();
  await seed(c, 'health');
  await c.put('/api/backup', { enabled: true, interval_hours: 24, keep: 3, remote: '', copy_dir: '' });
  for (const k of ['backup.last_ok', 'backup.last_at', 'backup.last_message', 'backup.history']) setSetting(k, '');
  assert.equal(backupHealth().state, 'warning');                                                           // enabled, never succeeded
  assert.match(backupHealth().message, /No successful backup yet/);

  const good = await runBackup();
  assert.equal(good.ok, true, good.message);
  const lastOk = db.prepare("SELECT value FROM settings WHERE key = 'backup.last_ok'").get().value;
  assert.equal(backupHealth().state, 'ok');
  assert.match(good.message, /verified \(\d+ receipts/);

  const before = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => f.endsWith('.zip')).length;
  await new Promise((r) => setTimeout(r, 1100));
  const bad = await runBackup({ verifier: async () => ({ ok: false, errors: ['database integrity check failed: boom'], warnings: [], info: {} }) });
  assert.equal(bad.ok, false); assert.match(bad.message, /verification FAILED: database integrity check failed: boom/);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => f.endsWith('.zip')).length, before);   // the bad file was removed
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'backup.last_ok'").get().value, lastOk);       // not counted as a success
  assert.equal(backupHealth().state, 'error');

  const hist = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'backup.history'").get().value);
  assert.deepEqual(hist.map((h) => [h.ok, h.verified]), [[false, false], [true, true]]);                          // newest first
  assert.ok(hist[1].counts.receipts >= 1 && hist[1].size > 0);

  // stale: a healthy-looking backup that is far older than the schedule says it should be
  setSetting('backup.last_message', 'saved x; verified');
  setSetting('backup.last_at', new Date().toISOString());
  setSetting('backup.last_ok', new Date().toISOString());
  assert.equal(backupHealth().state, 'ok');
  const stale = backupHealth(Date.now() + 60 * 3600e3);
  assert.equal(stale.state, 'warning'); assert.match(stale.message, /hours old/);
  await c.put('/api/backup', { enabled: false, interval_hours: 24, keep: 3, remote: '', copy_dir: '' });
  assert.equal(backupHealth().state, 'warning'); assert.match(backupHealth().message, /off/);

  // the API exposes it to admins
  assert.equal((await c.get('/api/backup/health')).body.state, 'warning');
  assert.equal((await c.get('/api/backup')).body.health.state, 'warning');
});

test('uploads are size-checked; unsafe settings are refused', async () => {
  const c = await adminClient();
  const root = path.join(work, 'drive'), bin = path.join(work, 'rclone');
  fs.writeFileSync(bin, `#!/bin/sh
cmd=$1; shift
p() { echo "$FAKE_REMOTE_ROOT/\${1#*:}"; }
case "$cmd" in
  copyto) mkdir -p "$(dirname "$(p "$2")")"; if [ -n "$FAKE_TRUNCATE" ]; then head -c 10 "$1" > "$(p "$2")"; else cp "$1" "$(p "$2")"; fi ;;
  size) f="$(p "$2")"; printf '{"count":1,"bytes":%s}\\n' "$(wc -c < "$f")" ;;
  lsf) ls "$(p "$2")" ;;
  deletefile) rm "$(p "$1")" ;;
esac
`, { mode: 0o755 });
  process.env.RCLONE_BIN = bin; process.env.FAKE_REMOTE_ROOT = root;
  await c.put('/api/backup', { enabled: true, interval_hours: 24, keep: 3, remote: 'gdrive:RB', copy_dir: '' });

  process.env.FAKE_TRUNCATE = '1';
  const bad = await runBackup();
  assert.equal(bad.ok, false); assert.match(bad.message, /upload FAILED: uploaded 10 bytes but the file is \d+/);
  assert.match(bad.message, /verified/);                                                                    // the local backup itself is good and kept
  delete process.env.FAKE_TRUNCATE;
  await new Promise((r) => setTimeout(r, 1100));
  const good = await runBackup();
  assert.equal(good.ok, true, good.message); assert.match(good.message, /size confirmed/);

  // settings that could do harm
  const cfg = { enabled: true, interval_hours: 24, keep: 3 };
  for (const remote of ['-v:path', '--config=x:y', 'no colon', ':bare'])
    assert.equal((await c.put('/api/backup', { ...cfg, remote })).status, 400, remote);                      // looks like an rclone option / malformed
  for (const copy_dir of [DATA_DIR, path.join(DATA_DIR, 'images'), path.join(DATA_DIR, 'x'), 'relative/dir'])
    assert.equal((await c.put('/api/backup', { ...cfg, copy_dir })).status, 400, copy_dir);                  // never inside the app's own data
  assert.equal((await c.put('/api/backup', { ...cfg, copy_dir: path.join(work, 'elsewhere') })).status, 200);
  await c.put('/api/backup', { ...cfg, remote: '', copy_dir: '' });
});

test('restore script: verify-only, refuses damaged backups, swaps atomically, keeps the old data, accepts old-format backups', async () => {
  const c = await adminClient();
  await seed(c, 'restore');
  const good = tmpName(); const { manifest } = await createBackup(good);
  const run = (args, env = {}) => spawnSync('node', ['--no-warnings', 'scripts/restore.js', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

  const dir1 = path.join(work, 'r1');
  const vo = run(['--verify-only', good], { DATA_DIR: dir1 });
  assert.equal(vo.status, 0, vo.stderr); assert.match(vo.stdout, /Verifying the backup… OK/); assert.match(vo.stdout, /\d+ receipts/);
  assert.equal(fs.existsSync(path.join(dir1, 'receipts.db')), false);                                      // verify-only changes nothing

  // damaged: refuses and leaves existing data alone
  const bytes = fs.readFileSync(good), flipped = Buffer.from(bytes);
  flipped[bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]), bytes.indexOf('images/') + 10) + 200] ^= 0xff;
  const bad = tmpName(); fs.writeFileSync(bad, flipped);
  const dir2 = path.join(work, 'r2'); fs.mkdirSync(path.join(dir2, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'receipts.db'), 'EXISTING'); fs.writeFileSync(path.join(dir2, 'images', 'keep.jpg'), 'KEEP');
  const refused = run([bad], { DATA_DIR: dir2 });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /ERROR|Refusing/);
  assert.equal(fs.readFileSync(path.join(dir2, 'receipts.db'), 'utf8'), 'EXISTING');
  assert.equal(fs.existsSync(path.join(dir2, 'images', 'keep.jpg')), true);
  assert.deepEqual(fs.readdirSync(dir2).filter((f) => f.startsWith('.restore-')), []);                    // staging folder removed

  // good restore over existing data: new data in place, old data kept aside, permissions tight, nothing left behind
  const ok = run([good], { DATA_DIR: dir2 });
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, new RegExp(`Restored the database and ${manifest.images.length} photo`));
  const restored = new DatabaseSync(path.join(dir2, 'receipts.db'), { readOnly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM receipts WHERE draft = 0').get().n, manifest.counts.receipts); restored.close();
  assert.equal(fs.readdirSync(path.join(dir2, 'images')).length, manifest.images.length);
  const aside = fs.readdirSync(dir2).find((f) => f.startsWith('pre-restore-'));
  assert.equal(fs.readFileSync(path.join(dir2, aside, 'receipts.db'), 'utf8'), 'EXISTING');
  assert.equal(fs.readFileSync(path.join(dir2, aside, 'images', 'keep.jpg'), 'utf8'), 'KEEP');
  assert.deepEqual(fs.readdirSync(dir2).filter((f) => f.startsWith('.restore-')), []);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir2, 'receipts.db')).mode & 0o777, 0o600);

  // an old (format 1) backup: manifest without counts, all photos in images/ — still restorable
  const old = tmpName(), dbBuf = await zipRead(good, 'receipts.db');
  await writeZip(old, [{ name: 'manifest.json', buffer: Buffer.from(JSON.stringify({ app: 'receipt-boss', created: '2026-01-01T00:00:00Z', format: 1 })) }, { name: 'receipts.db', buffer: dbBuf },
    ...(await Promise.all(manifest.images.map(async (i) => ({ name: `images/${i.name}`, buffer: await zipRead(good, `images/${i.name}`) }))))]);
  const dir3 = path.join(work, 'r3');
  const r3 = run([old], { DATA_DIR: dir3 });
  assert.equal(r3.status, 0, r3.stderr); assert.match(r3.stdout, /format 1/);
});
