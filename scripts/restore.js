#!/usr/bin/env node
// Restore a Receipt Boss backup zip into DATA_DIR.  STOP THE SERVER FIRST.
//   DATA_DIR=/srv/receipt-boss node scripts/restore.js receipt-boss-backup-20260101-020000.zip
// The current data is moved aside to DATA_DIR/pre-restore-<timestamp>/ rather than deleted.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const zipPath = process.argv[2];
if (!zipPath || !fs.existsSync(zipPath)) {
  console.error('usage: node scripts/restore.js <backup.zip>');
  process.exit(1);
}
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const zip = new AdmZip(zipPath);
const names = zip.getEntries().map((e) => e.entryName);
if (!names.includes('receipts.db') || !names.includes('manifest.json')) {
  console.error('That does not look like a Receipt Boss backup (receipts.db / manifest.json missing).');
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
const aside = path.join(dataDir, `pre-restore-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`);
fs.mkdirSync(aside);
for (const f of ['receipts.db', 'receipts.db-wal', 'receipts.db-shm', 'images']) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) fs.renameSync(src, path.join(aside, f));
}
fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });

let images = 0;
for (const e of zip.getEntries()) {
  if (e.isDirectory) continue;
  if (e.entryName === 'receipts.db') fs.writeFileSync(path.join(dataDir, 'receipts.db'), e.getData());
  else if (/^images\/[A-Za-z0-9._-]+$/.test(e.entryName)) { // strict name check: no path traversal from a crafted zip
    fs.writeFileSync(path.join(dataDir, 'images', path.basename(e.entryName)), e.getData());
    images++;
  }
}
console.log(`Restored database and ${images} image(s) into ${dataDir}`);
console.log(`Previous data kept in ${aside}`);
