// Proves a backup is usable WITHOUT touching the live data: every zip entry is checked against its CRC-32, the database is
// opened and integrity-checked, the manifest's counts must match the database, and every photo the database refers to must be
// in the archive. Used after each backup, by the "Verify" button, and by scripts/restore.js before it replaces anything.
// Deliberately imports nothing that opens the live database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eachEntry, consume } from './zip.js';
import { decryptFile, looksEncrypted } from './crypto-backup.js';

export const IMAGE_ENTRY = /^images\/[A-Za-z0-9._-]+$/;
const MAX_DB_BYTES = 64 * 1024 ** 3;
const COUNTS = { users: 'SELECT COUNT(*) n FROM users', projects: 'SELECT COUNT(*) n FROM projects', receipts: 'SELECT COUNT(*) n FROM receipts WHERE draft = 0',
  drafts: 'SELECT COUNT(*) n FROM receipts WHERE draft = 1', items: 'SELECT COUNT(*) n FROM items', photos: 'SELECT (SELECT COUNT(*) FROM receipt_photos) + (SELECT COUNT(*) FROM item_photos) n' };

export function databaseCounts(db) {
  const out = {};
  for (const [k, sql] of Object.entries(COUNTS)) { try { out[k] = db.prepare(sql).get().n; } catch { out[k] = null; } }   // older schemas lack some tables
  return out;
}
export const referencedPhotos = (db) => {
  try { return new Set(db.prepare('SELECT file FROM receipt_photos UNION SELECT file FROM item_photos').all().map((r) => r.file)); }
  catch { return new Set(); }
};

/**
 * @returns {Promise<{ ok: boolean, errors: string[], warnings: string[], info: object }>}
 */
export async function verifyBackup(file, { passphrase = '', workDir = os.tmpdir() } = {}) {
  const errors = [], warnings = [], info = { encrypted: looksEncrypted(file), bytes: 0 };
  const tmp = fs.mkdtempSync(path.join(workDir, 'rb-verify-'));
  try {
    info.bytes = fs.statSync(file).size;
    let zipPath = file;
    if (info.encrypted) {
      if (!passphrase) return { ok: false, errors: ['this backup is encrypted — a passphrase is needed to check it'], warnings, info };
      zipPath = path.join(tmp, 'decrypted.zip');
      try { await decryptFile(file, zipPath, passphrase); } catch (e) { return { ok: false, errors: [e.message], warnings, info }; }
    }

    let manifest = null, dbPath = null;
    const images = new Map();                                                       // entry name -> bytes (each CRC-verified)
    try {
      await eachEntry(zipPath, async (entry, open) => {
        const name = entry.fileName;
        if (name === 'manifest.json') {
          try { manifest = JSON.parse((await consume(entry, await open(), { toBuffer: true, maxBytes: 4 * 1024 * 1024 })).toString('utf8')); }
          catch (e) { errors.push(`manifest.json is unreadable: ${e.message}`); }
        } else if (name === 'receipts.db') {
          dbPath = path.join(tmp, 'receipts.db');
          await consume(entry, await open(), { dest: dbPath, maxBytes: MAX_DB_BYTES });
        } else if (IMAGE_ENTRY.test(name)) {
          images.set(name.slice('images/'.length), await consume(entry, await open()));
        } else warnings.push(`unexpected file in the backup: ${name}`);
      });
    } catch (e) { return { ok: false, errors: [`the archive is damaged: ${e.message}`], warnings, info }; }

    if (!dbPath) return { ok: false, errors: ['the backup has no receipts.db'], warnings, info };
    if (!manifest) warnings.push('no manifest.json (an old backup format) — only the database could be checked');
    info.format = manifest?.format ?? 1; info.created = manifest?.created ?? '';
    info.images = images.size;

    let snap;
    try { snap = new DatabaseSync(dbPath, { readOnly: true }); }
    catch (e) { return { ok: false, errors: [`the database cannot be opened: ${e.message}`], warnings, info }; }
    try {
      const integrity = snap.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
      if (integrity.length !== 1 || integrity[0] !== 'ok') errors.push(`database integrity check failed: ${integrity.slice(0, 3).join('; ')}`);
      info.schema = snap.prepare('PRAGMA user_version').get().user_version;
      info.counts = databaseCounts(snap);

      const missingOk = new Set(manifest?.missing || []);
      const missing = [...referencedPhotos(snap)].filter((f) => !images.has(f));
      const unexpected = missing.filter((f) => !missingOk.has(f));
      if (unexpected.length) errors.push(`${unexpected.length} photo file(s) the database refers to are missing from the backup (e.g. ${unexpected[0]})`);
      if (missing.length - unexpected.length) warnings.push(`${missing.length - unexpected.length} photo(s) were already missing on the server when this backup was made`);

      if (manifest?.counts) {
        for (const [k, v] of Object.entries(manifest.counts)) if (info.counts[k] !== v) errors.push(`manifest says ${v} ${k}, the database has ${info.counts[k]}`);
      }
      for (const im of manifest?.images || []) {
        if (!images.has(im.name)) errors.push(`manifest lists ${im.name} but it is not in the archive`);
        else if (images.get(im.name) !== im.size) errors.push(`${im.name} has a different size than recorded`);
      }
    } catch (e) {
      errors.push(`the database is damaged: ${e.message}`);       // e.g. "file is not a database": opens fine, fails on the first query
    } finally { snap.close(); }
    return { ok: errors.length === 0, errors, warnings, info };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
