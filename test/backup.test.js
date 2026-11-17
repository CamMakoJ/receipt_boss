import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import { start, stop, adminClient, img, DATA_DIR } from './helper.js';

before(start); after(stop);

// Stand-in for rclone: "remote:dir/..." maps to $FAKE_REMOTE_ROOT/dir/...
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-bk-'));
const remoteRoot = path.join(tmp, 'drive');
const fake = path.join(tmp, 'rclone');
fs.writeFileSync(fake, `#!/bin/sh
cmd=$1; shift
p() { echo "$FAKE_REMOTE_ROOT/\${1#*:}"; }
case "$cmd" in
  copyto) mkdir -p "$(dirname "$(p "$2")")"; cp "$1" "$(p "$2")" ;;
  lsf) ls "$(p "$2")" ;;
  deletefile) rm "$(p "$1")" ;;
  *) echo "unexpected $cmd" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
process.env.RCLONE_BIN = fake;
process.env.FAKE_REMOTE_ROOT = remoteRoot;

test('backup run: local zip, folder copy, rclone upload, retention; then restore', async () => {
  const c = await adminClient();
  const p = (await c.post('/api/projects', { name: 'P' })).body;
  await c.post(`/api/projects/${p.id}/receipts`, { subtotal: 1234, description: 'one', image: img(1) });
  await c.post('/api/items', { name: 'Fridge', purchase_date: '2025-01-01', image: img(2) });

  const copyDir = path.join(tmp, 'copy');
  const cfg = { enabled: true, interval_hours: 24, keep: 2, remote: 'gdrive:ReceiptBoss', copy_dir: copyDir };
  assert.equal((await c.put('/api/backup', { ...cfg, remote: 'bad remote' })).status, 400);
  assert.equal((await c.put('/api/backup', { ...cfg, copy_dir: 'relative/dir' })).status, 400);
  assert.equal((await c.put('/api/backup', cfg)).status, 200);

  let last;
  for (let i = 0; i < 3; i++) {
    last = await c.post('/api/backup/run');
    assert.equal(last.status, 200, JSON.stringify(last.body));
    await new Promise((r) => setTimeout(r, 1100)); // names carry second-resolution timestamps
  }
  assert.match(last.body.message, /uploaded to gdrive:ReceiptBoss/);
  // retention keeps only the newest 2 in all three places
  assert.equal(last.body.files.length, 2);
  assert.equal(fs.readdirSync(copyDir).length, 2);
  assert.equal(fs.readdirSync(path.join(remoteRoot, 'ReceiptBoss')).length, 2);

  // backup contents: db snapshot with no sessions, both images, manifest
  const file = path.join(DATA_DIR, 'backups', last.body.files[0].name);
  const zip = new AdmZip(file);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('receipts.db') && names.includes('manifest.json'));
  assert.equal(names.filter((n) => n.startsWith('images/') && n.length > 7).length, 2);
  const snapDir = fs.mkdtempSync(path.join(tmp, 'snap-'));
  fs.writeFileSync(path.join(snapDir, 'x.db'), zip.getEntry('receipts.db').getData());
  const snap = new DatabaseSync(path.join(snapDir, 'x.db'));
  assert.equal(snap.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  assert.equal(snap.prepare('SELECT COUNT(*) n FROM receipts').get().n, 1);
  snap.close();

  // download endpoint gives a valid zip too
  const dl = await c.get('/api/backup/download');
  assert.equal(dl.status, 200);
  assert.equal(dl.body.subarray(0, 2).toString(), 'PK');
  assert.equal((await c.get('/api/backup/files/../../etc/passwd')).status, 404);

  // a failing remote is reported, not thrown, and the local backup still exists
  await c.put('/api/backup', { ...cfg, remote: 'nope:x' });
  process.env.RCLONE_BIN = '/nonexistent/rclone';
  const bad = await c.post('/api/backup/run');
  assert.equal(bad.status, 502);
  assert.match(bad.body.message, /rclone is not installed/);
  process.env.RCLONE_BIN = fake;

  // restore into a brand new data dir with the CLI
  const fresh = path.join(tmp, 'restored');
  const out = execFileSync('node', ['--no-warnings', 'scripts/restore.js', file], { env: { ...process.env, DATA_DIR: fresh } }).toString();
  assert.match(out, /Restored database and 2 image/);
  const db2 = new DatabaseSync(path.join(fresh, 'receipts.db'));
  assert.equal(db2.prepare("SELECT description FROM receipts").get().description, 'one');
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  db2.close();
  assert.equal(fs.readdirSync(path.join(fresh, 'images')).length, 2);
  assert.equal(await c.get('/api/projects').then((r) => r.body.length), 1); // live server unaffected
});
