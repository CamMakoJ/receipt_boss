// Backups: one zip with a consistent copy of the database and exactly the photos it refers to, a manifest, and (optionally) AES-256
// encryption. Each backup is VERIFIED after it is written and before anything else happens with it:
//   1. snapshot   database copy + hard-links to the referenced photo files, taken in one synchronous step (nothing can change in between)
//   2. write      to <name>.partial, then renamed: a half-written backup can never be mistaken for a good one
//   3. verify     every entry's CRC-32, the database's integrity_check, manifest counts, every referenced photo present
//   4. keep       DATA_DIR/backups (+ retention), an optional second folder, an optional rclone remote (Google Drive...) whose size is re-checked
// A backup that fails verification is deleted and does not count as a success. Google credentials never enter this app (rclone holds them).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { db, DATA_DIR, IMAGE_DIR, BACKUP_DIR, getSetting, setSetting } from './db.js';
import { err, wrap } from './http.js';
import { requireAdmin } from './auth.js';
import { encryptFile, looksEncrypted } from './crypto-backup.js';
import { buildZip } from './zip.js';
import { verifyBackup, databaseCounts, referencedPhotos } from './backup-verify.js';

const run = promisify(execFile);
export const TMP_DIR = path.join(DATA_DIR, 'tmp');                    // same disk as the data, so large backups never fill /tmp
const NAME_RE = /^receipt-boss-backup-\d{8}-\d{6}\.zip(\.enc)?$/;
const REMOTE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:[^\0\r\n]*$/;         // rclone "remote:path" (cannot start with "-": it would read as an option)
const HISTORY_MAX = 10;
for (const d of [TMP_DIR, BACKUP_DIR]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch { /* ignore */ } }

let running = false;

export const backupConfig = () => ({
  enabled: getSetting('backup.enabled', '0') === '1',
  interval_hours: Number(getSetting('backup.interval_hours', '24')),
  keep: Number(getSetting('backup.keep', '14')),
  remote: getSetting('backup.remote', ''),
  copy_dir: getSetting('backup.copy_dir', ''),
  encrypt: getSetting('backup.encrypt', '0') === '1' && !!getSetting('backup.passphrase', ''),
  has_passphrase: !!getSetting('backup.passphrase', ''),              // the passphrase itself is never sent to the browser
});
const passphraseIfEncrypting = () => (backupConfig().encrypt ? getSetting('backup.passphrase', '') : '');
const history = () => { try { return JSON.parse(getSetting('backup.history', '[]')); } catch { return []; } };

export const backupStatus = () => ({
  last_at: getSetting('backup.last_at', ''),
  last_ok: getSetting('backup.last_ok', ''),
  last_message: getSetting('backup.last_message', ''),
  running,
  history: history(),
});

/** One glanceable verdict for admins: is the safety net actually working? */
export function backupHealth(now = Date.now()) {
  const cfg = backupConfig(), lastOk = Date.parse(getSetting('backup.last_ok', '')) || 0, lastTry = Date.parse(getSetting('backup.last_at', '')) || 0;
  const ageH = lastOk ? (now - lastOk) / 3600e3 : null;
  const base = { last_ok: getSetting('backup.last_ok', ''), age_hours: ageH === null ? null : Math.round(ageH * 10) / 10 };
  if (!cfg.enabled && !lastOk) return { ...base, state: 'off', message: 'No backups yet — automatic backups are off.' };
  if (!cfg.enabled) return { ...base, state: 'warning', message: 'Automatic backups are off.' };
  if (lastTry > lastOk && /FAILED|failed/.test(getSetting('backup.last_message', ''))) return { ...base, state: 'error', message: 'The last backup failed — see Settings → Backup.' };
  if (!lastOk) return { ...base, state: 'warning', message: 'No successful backup yet.' };
  if (ageH > cfg.interval_hours * 2 + 1) return { ...base, state: 'warning', message: `The last good backup is ${Math.round(ageH)} hours old.` };
  return { ...base, state: 'ok', message: 'Backups are healthy.' };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const sqlQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const sha256File = async (file) => { const h = crypto.createHash('sha256'); await pipeline(fs.createReadStream(file), h); return h.digest('hex'); };

/**
 * Database snapshot + the photo files it refers to, hard-linked into `work/images`. Everything here is SYNCHRONOUS on purpose:
 * Node runs one thing at a time and node:sqlite is synchronous, so no request can add or delete a photo between the snapshot and
 * the linking. Links (not copies) are instant, cost no disk, and keep each file alive even if it is deleted a moment later.
 */
function takeSnapshot(work) {
  const dbPath = path.join(work, 'receipts.db');
  db.exec(`VACUUM INTO ${sqlQuote(dbPath)}`);
  const snap = new DatabaseSync(dbPath);
  let referenced, counts, schema;
  try {
    snap.exec("DELETE FROM sessions; DELETE FROM settings WHERE key IN ('ai.api_key', 'backup.passphrase')");   // never ship sign-ins, the AI key or the backup passphrase
    referenced = [...referencedPhotos(snap)].sort();
    counts = databaseCounts(snap);
    schema = snap.prepare('PRAGMA user_version').get().user_version;
  } finally { snap.close(); }

  fs.mkdirSync(path.join(work, 'images'));
  const images = [], missing = [];
  for (const name of referenced) {
    const src = path.join(IMAGE_DIR, name), dst = path.join(work, 'images', name);
    try {
      try { fs.linkSync(src, dst); } catch (e) { if (e.code === 'EXDEV' || e.code === 'EPERM') fs.copyFileSync(src, dst); else throw e; }
      images.push({ name, size: fs.statSync(dst).size });
    } catch (e) { if (e.code === 'ENOENT') missing.push(name); else throw e; }
  }
  let orphans = 0;
  try { const ref = new Set(referenced); orphans = fs.readdirSync(IMAGE_DIR).filter((f) => !ref.has(f)).length; } catch { /* informational only */ }
  return { dbPath, images, missing, orphans, counts, schema };
}

/** Create a backup at `dest` (atomically). Safe while the server is running. */
export async function createBackup(dest, { passphrase = '' } = {}) {
  const work = fs.mkdtempSync(path.join(TMP_DIR, 'backup-'));
  const partial = `${dest}.partial`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const snap = takeSnapshot(work);
    const manifest = {
      app: 'receipt-boss', format: 2, created: new Date().toISOString(), schema: snap.schema, counts: snap.counts,
      db_sha256: await sha256File(snap.dbPath), images: snap.images, missing: snap.missing, orphans_skipped: snap.orphans,
    };
    const entries = [
      { name: 'manifest.json', buffer: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'receipts.db', file: snap.dbPath },
      ...snap.images.map((i) => ({ name: `images/${i.name}`, file: path.join(work, 'images', i.name), compress: false })),   // JPEGs don't compress
    ];
    const zipPath = passphrase ? path.join(work, 'backup.zip') : partial;
    await pipeline(buildZip(entries), fs.createWriteStream(zipPath, { mode: 0o600 }));
    if (passphrase) await encryptFile(zipPath, partial, passphrase);
    try { fs.chmodSync(partial, 0o600); } catch { /* ignore */ }
    fs.renameSync(partial, dest);                                       // atomic: readers never see half a backup
    return { file: dest, size: fs.statSync(dest).size, manifest };
  } catch (e) { fs.rmSync(partial, { force: true }); throw e; }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- rclone
const rcloneBin = () => process.env.RCLONE_BIN || 'rclone';
const rclone = (args) => run(rcloneBin(), args, { timeout: 30 * 60e3, maxBuffer: 10e6 });
const remoteJoin = (remote, name) => (name ? (/[:/]$/.test(remote) ? remote + name : `${remote}/${name}`) : remote);

export const listLocalBackups = () =>
  (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : []).filter((n) => NAME_RE.test(n)).sort().reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(BACKUP_DIR, name)).size, encrypted: name.endsWith('.enc') }));

/** Leftovers from a crash: half-written backups and temp dirs. Called at start-up. */
export function cleanupTemp() {
  for (const dir of [TMP_DIR, BACKUP_DIR]) {
    for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (dir === TMP_DIR || n.endsWith('.partial')) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
  }
}

/** Full run: create -> verify -> retention -> extra folder -> rclone (size re-checked). Never throws. */
export async function runBackup({ verifier = verifyBackup } = {}) {   // (verifier is injectable so the failure path can be tested)
  if (running) return { ok: false, message: 'a backup is already running' };
  running = true;
  const t0 = Date.now(), cfg = backupConfig(), pass = passphraseIfEncrypting(), steps = [];
  let ok = true, size = 0, verified = false, counts = null;
  try {
    const name = `receipt-boss-backup-${stamp()}.zip${pass ? '.enc' : ''}`;
    const created = await createBackup(path.join(BACKUP_DIR, name), { passphrase: pass });
    size = created.size;
    steps.push(`saved ${name}${pass ? ' (encrypted)' : ''} (${(size / 1048576).toFixed(1)} MB)`);

    const v = await verifier(created.file, { passphrase: pass, workDir: TMP_DIR });
    if (!v.ok) {
      fs.rmSync(created.file, { force: true });                         // a backup we can't trust must not look like one
      throw new Error(`verification FAILED: ${v.errors[0]}`);
    }
    verified = true; counts = v.info.counts;
    steps.push(`verified (${v.info.counts.receipts} receipts, ${v.info.counts.items} items, ${v.info.images} photos)${v.warnings.length ? `; note: ${v.warnings[0]}` : ''}`);

    for (const old of listLocalBackups().slice(cfg.keep)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });   // only after a verified one exists

    if (cfg.copy_dir) {
      try {
        fs.mkdirSync(cfg.copy_dir, { recursive: true });
        const dst = path.join(cfg.copy_dir, name), tmp = `${dst}.partial`;
        fs.copyFileSync(created.file, tmp);
        if (fs.statSync(tmp).size !== size) throw new Error('the copy has a different size');
        fs.renameSync(tmp, dst);
        for (const n of fs.readdirSync(cfg.copy_dir).filter((f) => NAME_RE.test(f)).sort().reverse().slice(cfg.keep)) fs.rmSync(path.join(cfg.copy_dir, n), { force: true });
        steps.push(`copied to ${cfg.copy_dir}`);
      } catch (e) { ok = false; steps.push(`copy to folder FAILED: ${e.message}`); }
    }

    if (cfg.remote) {
      try {
        await rclone(['copyto', created.file, remoteJoin(cfg.remote, name)]);
        const { stdout: sizeJson } = await rclone(['size', '--json', remoteJoin(cfg.remote, name)]);
        const remoteBytes = JSON.parse(sizeJson).bytes;
        if (remoteBytes !== size) throw new Error(`uploaded ${remoteBytes} bytes but the file is ${size}`);
        steps.push(`uploaded to ${cfg.remote} (size confirmed)`);
        const { stdout } = await rclone(['lsf', '--files-only', remoteJoin(cfg.remote, '')]);
        const old = stdout.split('\n').map((s) => s.trim()).filter((n) => NAME_RE.test(n)).sort().reverse().slice(cfg.keep);
        for (const n of old) await rclone(['deletefile', remoteJoin(cfg.remote, n)]);
        if (old.length) steps.push(`removed ${old.length} old remote backup(s)`);
      } catch (e) {
        ok = false;
        const detail = e.code === 'ENOENT' ? 'rclone is not installed' : (e.stderr || e.message || '').toString().trim().split('\n').slice(-2).join(' ');
        steps.push(`upload FAILED: ${detail}`);
      }
    }
  } catch (e) {
    ok = false; steps.push(e.message.startsWith('verification') ? e.message : `backup FAILED: ${e.message}`);
  } finally { running = false; }

  const message = steps.join('; '), at = new Date().toISOString();
  setSetting('backup.last_at', at);
  setSetting('backup.last_message', message);
  if (ok) setSetting('backup.last_ok', at);
  setSetting('backup.history', JSON.stringify([{ at, ok, verified, size, seconds: Math.round((Date.now() - t0) / 100) / 10, counts, message }, ...history()].slice(0, HISTORY_MAX)));
  return { ok, message };
}

/** Checks every 10 minutes; runs a backup when the configured interval has elapsed since the last success. */
export function startBackupScheduler() {
  cleanupTemp();
  const tick = () => {
    const cfg = backupConfig();
    if (!cfg.enabled) return;
    const last = Date.parse(getSetting('backup.last_ok', '')) || 0;
    const lastTry = Date.parse(getSetting('backup.last_at', '')) || 0;
    const due = Date.now() - last >= cfg.interval_hours * 3600e3;
    const cooled = Date.now() - lastTry >= 30 * 60e3;                    // after a failure, retry at most every 30 min
    if (due && cooled) runBackup().then((r) => console.log(`[backup] ${r.ok ? 'ok' : 'problem'}: ${r.message}`));
  };
  setTimeout(tick, 15e3).unref();
  setInterval(tick, 10 * 60e3).unref();
}

// ---------------------------------------------------------------- routes (admin only)
const isInside = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export function registerBackup(app) {
  const snapshot = () => ({ config: backupConfig(), status: backupStatus(), files: listLocalBackups(), health: backupHealth() });
  app.get('/api/backup', requireAdmin, (req, res) => res.json(snapshot()));
  app.get('/api/backup/health', requireAdmin, (req, res) => res.json(backupHealth()));

  app.put('/api/backup', requireAdmin, (req, res) => {
    const b = req.body || {};
    const remote = String(b.remote ?? '').trim();
    if (remote && !REMOTE_RE.test(remote)) throw err(400, 'remote must look like  gdrive:ReceiptBoss  (an rclone remote name, a colon, then an optional folder)');
    let copyDir = String(b.copy_dir ?? '').trim();
    if (copyDir) {
      if (!path.isAbsolute(copyDir) || copyDir.includes('\0')) throw err(400, 'folder must be an absolute path');
      copyDir = path.resolve(copyDir);
      if (isInside(copyDir, DATA_DIR)) throw err(400, 'choose a folder outside the app’s data folder (the local copies already live there)');
    }
    const hours = Number(b.interval_hours), keep = Number(b.keep);
    if (!(hours >= 1 && hours <= 24 * 30)) throw err(400, 'interval must be 1 hour to 30 days');
    if (!(Number.isInteger(keep) && keep >= 1 && keep <= 365)) throw err(400, 'keep must be 1-365');
    // encryption: the passphrase is write-only; enabling needs one (already saved, or sent now)
    const newPass = typeof b.passphrase === 'string' ? b.passphrase : '';
    if (newPass && newPass.length < 10) throw err(400, 'the backup passphrase must be at least 10 characters');
    if (b.encrypt && !newPass && !getSetting('backup.passphrase', '')) throw err(400, 'enter a passphrase to turn on encryption');
    setSetting('backup.enabled', b.enabled ? '1' : '0');
    if (b.clear_passphrase) { setSetting('backup.passphrase', ''); setSetting('backup.encrypt', '0'); }
    else { if (newPass) setSetting('backup.passphrase', newPass); setSetting('backup.encrypt', b.encrypt ? '1' : '0'); }
    setSetting('backup.interval_hours', hours);
    setSetting('backup.keep', keep);
    setSetting('backup.remote', remote);
    setSetting('backup.copy_dir', copyDir);
    res.json(snapshot());
  });

  app.post('/api/backup/run', requireAdmin, wrap(async (req, res) => {
    const result = await runBackup();
    res.status(result.ok ? 200 : 502).json({ ...result, ...snapshot() });
  }));

  // On-demand download of a fresh backup (straight to your device).
  app.get('/api/backup/download', requireAdmin, wrap(async (req, res) => {
    const pass = passphraseIfEncrypting(), ext = pass ? '.zip.enc' : '.zip';
    const tmp = path.join(TMP_DIR, `download-${process.pid}-${Date.now()}${ext}`);
    await createBackup(tmp, { passphrase: pass });
    res.download(tmp, `receipt-boss-backup-${stamp()}${ext}`, () => fs.rmSync(tmp, { force: true }));
  }));

  // Check a saved backup (the newest by default). For an encrypted one, the passphrase you type must open it — proof you can recover.
  app.post('/api/backup/verify', requireAdmin, wrap(async (req, res) => {
    const files = listLocalBackups(), wanted = req.body?.name, pass = String(req.body?.passphrase ?? '');
    // a typed passphrase means "prove I can open it": prefer the newest encrypted backup, else the newest of any kind
    const target = wanted ? files.find((f) => f.name === wanted) : (pass && files.find((f) => f.encrypted)) || files[0];
    if (!target) throw err(400, 'there is no backup on this server yet — run “Back up now” first');
    const result = await verifyBackup(path.join(BACKUP_DIR, target.name), { passphrase: pass, workDir: TMP_DIR });
    if (!result.ok) throw err(400, result.errors[0]);
    res.json({ ok: true, name: target.name, warnings: result.warnings, info: result.info });
  }));

  app.get('/api/backup/files/:name', requireAdmin, (req, res) => {
    if (!NAME_RE.test(req.params.name)) throw err(404, 'not found');
    const f = path.join(BACKUP_DIR, req.params.name);
    if (!fs.existsSync(f)) throw err(404, 'not found');
    res.download(f);
  });
}

export { looksEncrypted };
