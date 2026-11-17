#!/usr/bin/env node
// Restore a Receipt Boss backup into DATA_DIR.  STOP THE SERVER FIRST.
//
//   DATA_DIR=/srv/receipt-boss node scripts/restore.js receipt-boss-backup-20260101-020000.zip
//   node scripts/restore.js --verify-only backup.zip.enc     # just prove the backup is good; change nothing
//
// Order of operations (so a bad backup can never damage a working install):
//   1. (encrypted backups) decrypt — passphrase from RB_BACKUP_PASSPHRASE or typed (not echoed)
//   2. verify: every file's CRC-32, database integrity_check, manifest counts, every referenced photo present
//   3. extract into a staging folder inside DATA_DIR (only receipts.db and images/<name> are ever extracted)
//   4. move the current data aside to DATA_DIR/pre-restore-<timestamp>/ (never deleted), then swap the staged data in;
//      if the swap fails halfway, the previous data is put back.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { eachEntry, consume } from '../server/zip.js';
import { verifyBackup, IMAGE_ENTRY } from '../server/backup-verify.js';
import { decryptFile, looksEncrypted } from '../server/crypto-backup.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const input = args.find((a) => !a.startsWith('--'));
if (!input || !fs.existsSync(input)) {
  console.error('usage: node scripts/restore.js [--verify-only] [--force] <backup.zip | backup.zip.enc>\n' +
    '       encrypted backups: set RB_BACKUP_PASSPHRASE, or type the passphrase when asked\n' +
    '       --force restores even if verification reports problems (not recommended)');
  process.exit(1);
}
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const fail = (msg) => { console.error(msg); process.exit(1); };

async function askPassphrase() {
  if (process.env.RB_BACKUP_PASSPHRASE) return process.env.RB_BACKUP_PASSPHRASE;
  if (!process.stdin.isTTY) fail('This backup is encrypted. Set RB_BACKUP_PASSPHRASE, or run this in a terminal.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  rl._writeToOutput = (t) => { if (!muted) rl.output.write(t); };       // do not echo the passphrase
  return new Promise((resolve) => { rl.question('Backup passphrase: ', (a) => { rl.close(); console.log(); resolve(a); }); muted = true; });
}

// ---- 1. staging area on the same disk as the data (so the final swap is a rename, not a copy)
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const stage = path.join(dataDir, `.restore-${stamp}-${process.pid}`);
fs.mkdirSync(stage, { mode: 0o700 });
const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
process.on('exit', cleanup);

let zipPath = input;
if (looksEncrypted(input)) {
  zipPath = path.join(stage, 'decrypted.zip');
  try { await decryptFile(input, zipPath, await askPassphrase()); }
  catch (e) { fail(`Could not decrypt: ${e.message}`); }
}

// ---- 2. verify before touching anything
process.stdout.write('Verifying the backup… ');
const v = await verifyBackup(zipPath, { workDir: stage });
console.log(v.ok ? 'OK' : 'PROBLEMS FOUND');
const c = v.info.counts || {};
if (v.info.created) console.log(`  made ${v.info.created} (format ${v.info.format}, schema v${v.info.schema})`);
if (v.info.counts) console.log(`  ${c.receipts} receipts (+${c.drafts} drafts), ${c.items} household items, ${c.projects} projects, ${c.users} users, ${v.info.images} photos`);
v.warnings.forEach((w) => console.log(`  note: ${w}`));
v.errors.forEach((e) => console.error(`  ERROR: ${e}`));
if (flags.has('--verify-only')) process.exit(v.ok ? 0 : 1);
if (!v.ok && !flags.has('--force')) fail('Refusing to restore a backup that failed verification. (--force overrides.)');

// ---- 3. extract only what we know about
const stagedImages = path.join(stage, 'images');
fs.mkdirSync(stagedImages, { mode: 0o700 });
let images = 0;
await eachEntry(zipPath, async (entry, open) => {
  if (entry.fileName === 'receipts.db') await consume(entry, await open(), { dest: path.join(stage, 'receipts.db') });
  else if (IMAGE_ENTRY.test(entry.fileName)) { await consume(entry, await open(), { dest: path.join(stagedImages, path.basename(entry.fileName)) }); images++; }
});
if (!fs.existsSync(path.join(stage, 'receipts.db'))) fail('The backup has no receipts.db.');

// ---- 4. swap in, keeping the old data
const aside = path.join(dataDir, `pre-restore-${stamp}`);
fs.mkdirSync(aside, { mode: 0o700 });
const moved = [];
try {
  for (const name of ['receipts.db', 'receipts.db-wal', 'receipts.db-shm', 'images']) {
    const src = path.join(dataDir, name);
    if (fs.existsSync(src)) { fs.renameSync(src, path.join(aside, name)); moved.push(name); }
  }
  fs.renameSync(path.join(stage, 'receipts.db'), path.join(dataDir, 'receipts.db'));
  fs.renameSync(stagedImages, path.join(dataDir, 'images'));
} catch (e) {
  for (const name of moved) { try { fs.rmSync(path.join(dataDir, name), { recursive: true, force: true }); fs.renameSync(path.join(aside, name), path.join(dataDir, name)); } catch { /* best effort */ } }
  fail(`Restore failed and your previous data was put back: ${e.message}`);
}
try { fs.chmodSync(path.join(dataDir, 'receipts.db'), 0o600); fs.chmodSync(path.join(dataDir, 'images'), 0o700); } catch { /* ignore */ }

console.log(`Restored the database and ${images} photo(s) into ${dataDir}`);
console.log(`Previous data kept in ${aside}`);
console.log('Start the server again; it upgrades the database automatically if the backup is from an older version.');
