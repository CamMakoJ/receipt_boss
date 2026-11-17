// Backups: a zip containing a consistent copy of the database + every image.
//   1. written to DATA_DIR/backups (local retention)
//   2. optionally copied to another folder (e.g. a Google Drive / NAS mount)
//   3. optionally uploaded with rclone to any remote it supports -- Google Drive included.
// Google Drive access is configured once on the host with `rclone config` (see README); no Google
// credentials are ever stored in this app.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import archiver from 'archiver';
import { DatabaseSync } from 'node:sqlite';
import { db, DATA_DIR, IMAGE_DIR, BACKUP_DIR, getSetting, setSetting } from './db.js';
import { err, wrap } from './http.js';
import { requireAdmin } from './auth.js';
import { encryptFile, decryptFile, looksEncrypted } from './crypto-backup.js';

const run = promisify(execFile);
const NAME_RE = /^receipt-boss-backup-\d{8}-\d{6}\.zip(\.enc)?$/;
const REMOTE_RE = /^[A-Za-z0-9_.-]+:[^\0\r\n]*$/; // rclone "remote:path"

export const backupConfig = () => ({
  enabled: getSetting('backup.enabled', '0') === '1',
  interval_hours: Number(getSetting('backup.interval_hours', '24')),
  keep: Number(getSetting('backup.keep', '14')),
  remote: getSetting('backup.remote', ''),
  copy_dir: getSetting('backup.copy_dir', ''),
  encrypt: getSetting('backup.encrypt', '0') === '1' && !!getSetting('backup.passphrase', ''),
  has_passphrase: !!getSetting('backup.passphrase', ''),         // the passphrase itself is never sent to the browser
});
const passphraseIfEncrypting = () => (backupConfig().encrypt ? getSetting('backup.passphrase', '') : '');
export const backupStatus = () => ({
  last_at: getSetting('backup.last_at', ''),
  last_ok: getSetting('backup.last_ok', ''),
  last_message: getSetting('backup.last_message', ''),
  running,
});

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const sqlQuote = (s) => `'${s.replace(/'/g, "''")}'`;

/** Create a backup zip at `dest`. Safe while the server is running (uses VACUUM INTO). */
export async function createBackup(dest, { passphrase = '' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-backup-'));
  try {
    const snap = path.join(tmp, 'receipts.db');
    db.exec(`VACUUM INTO ${sqlQuote(snap)}`);
    const copy = new DatabaseSync(snap);
    copy.exec("DELETE FROM sessions; DELETE FROM settings WHERE key IN ('ai.api_key', 'backup.passphrase')"); // never ship login sessions, the AI key or the backup passphrase
    copy.close();

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const zipPath = passphrase ? path.join(tmp, 'backup.zip') : dest;      // encrypted: zip in the temp dir first, then encrypt to dest
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const zip = archiver('zip', { zlib: { level: 6 } });
      out.on('close', resolve); out.on('error', reject); zip.on('error', reject);
      zip.pipe(out);
      zip.file(snap, { name: 'receipts.db' });
      if (fs.existsSync(IMAGE_DIR)) zip.directory(IMAGE_DIR, 'images');
      zip.append(JSON.stringify({ app: 'receipt-boss', created: new Date().toISOString(), format: 1 }, null, 2), { name: 'manifest.json' });
      zip.finalize();
    });
    if (passphrase) await encryptFile(zipPath, dest, passphrase);
    return { file: dest, size: fs.statSync(dest).size };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const rcloneBin = () => process.env.RCLONE_BIN || 'rclone';
const rclone = (args) => run(rcloneBin(), args, { timeout: 30 * 60e3, maxBuffer: 10e6 });
const remoteJoin = (remote, name) => (name ? (/[:/]$/.test(remote) ? remote + name : `${remote}/${name}`) : remote);

export const listLocalBackups = () =>
  (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : []).filter((n) => NAME_RE.test(n)).sort().reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(BACKUP_DIR, name)).size }));

let running = false;

/** Full backup run: local zip -> optional copy dir -> optional rclone upload -> retention. Never throws. */
export async function runBackup() {
  if (running) return { ok: false, message: 'a backup is already running' };
  running = true;
  const cfg = backupConfig();
  const steps = [];
  let ok = true;
  try {
    const pass = passphraseIfEncrypting();
    const name = `receipt-boss-backup-${stamp()}.zip${pass ? '.enc' : ''}`;
    const { file, size } = await createBackup(path.join(BACKUP_DIR, name), { passphrase: pass });
    steps.push(`saved ${name}${pass ? ' (encrypted)' : ''} (${(size / 1048576).toFixed(1)} MB)`);

    for (const old of listLocalBackups().slice(cfg.keep)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });

    if (cfg.copy_dir) {
      try {
        fs.mkdirSync(cfg.copy_dir, { recursive: true });
        fs.copyFileSync(file, path.join(cfg.copy_dir, name));
        const olds = fs.readdirSync(cfg.copy_dir).filter((n) => NAME_RE.test(n)).sort().reverse().slice(cfg.keep);
        olds.forEach((n) => fs.rmSync(path.join(cfg.copy_dir, n), { force: true }));
        steps.push(`copied to ${cfg.copy_dir}`);
      } catch (e) { ok = false; steps.push(`copy to folder FAILED: ${e.message}`); }
    }

    if (cfg.remote) {
      try {
        await rclone(['copyto', file, remoteJoin(cfg.remote, name)]);
        steps.push(`uploaded to ${cfg.remote}`);
        const { stdout } = await rclone(['lsf', '--files-only', remoteJoin(cfg.remote, '')]);
        const remoteOld = stdout.split('\n').map((s) => s.trim()).filter((n) => NAME_RE.test(n)).sort().reverse().slice(cfg.keep);
        for (const n of remoteOld) await rclone(['deletefile', remoteJoin(cfg.remote, n)]);
        if (remoteOld.length) steps.push(`removed ${remoteOld.length} old remote backup(s)`);
      } catch (e) {
        ok = false;
        const detail = e.code === 'ENOENT' ? 'rclone is not installed' : (e.stderr || e.message || '').toString().trim().split('\n').slice(-2).join(' ');
        steps.push(`upload FAILED: ${detail}`);
      }
    }
  } catch (e) {
    ok = false; steps.push(`backup FAILED: ${e.message}`);
  } finally { running = false; }

  const message = steps.join('; ');
  setSetting('backup.last_at', new Date().toISOString());
  setSetting('backup.last_message', message);
  if (ok) setSetting('backup.last_ok', new Date().toISOString());
  return { ok, message };
}

/** Hourly check; runs a backup when the configured interval has elapsed since the last success. */
export function startBackupScheduler() {
  const tick = () => {
    const cfg = backupConfig();
    if (!cfg.enabled) return;
    const last = Date.parse(getSetting('backup.last_ok', '')) || 0;
    const lastTry = Date.parse(getSetting('backup.last_at', '')) || 0;
    const due = Date.now() - last >= cfg.interval_hours * 3600e3;
    const cooled = Date.now() - lastTry >= 30 * 60e3; // after a failure, retry at most every 30 min
    if (due && cooled) runBackup().then((r) => console.log(`[backup] ${r.ok ? 'ok' : 'problem'}: ${r.message}`));
  };
  setTimeout(tick, 15e3).unref();
  setInterval(tick, 10 * 60e3).unref();
}

export function registerBackup(app) {
  const snapshot = () => ({ config: backupConfig(), status: backupStatus(), files: listLocalBackups() });
  app.get('/api/backup', requireAdmin, (req, res) => res.json(snapshot()));

  app.put('/api/backup', requireAdmin, (req, res) => {
    const b = req.body || {};
    const remote = String(b.remote ?? '').trim();
    if (remote && !REMOTE_RE.test(remote)) throw err(400, 'remote must look like  gdrive:ReceiptBoss  (an rclone remote name, a colon, then an optional folder)');
    const copyDir = String(b.copy_dir ?? '').trim();
    if (copyDir && !path.isAbsolute(copyDir)) throw err(400, 'folder must be an absolute path');
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
    const tmp = path.join(os.tmpdir(), `rb-dl-${process.pid}-${Date.now()}${ext}`);
    await createBackup(tmp, { passphrase: pass });
    res.download(tmp, `receipt-boss-backup-${stamp()}${ext}`, () => fs.rmSync(tmp, { force: true }));
  }));

  // prove you can still decrypt: checks a saved encrypted backup against a passphrase you type (nothing is stored or restored)
  app.post('/api/backup/verify', requireAdmin, wrap(async (req, res) => {
    const pass = String(req.body?.passphrase ?? '');
    const name = listLocalBackups().find((f) => f.name.endsWith('.enc') && (!req.body?.name || f.name === req.body.name))?.name;
    if (!name) throw err(400, 'there is no encrypted backup on this server yet — run “Back up now” first');
    try { await decryptFile(path.join(BACKUP_DIR, name), null, pass); }
    catch (e) { throw err(400, e.message); }
    res.json({ ok: true, name });
  }));

  app.get('/api/backup/files/:name', requireAdmin, (req, res) => {
    if (!NAME_RE.test(req.params.name)) throw err(404, 'not found');
    const f = path.join(BACKUP_DIR, req.params.name);
    if (!fs.existsSync(f)) throw err(404, 'not found');
    res.download(f);
  });
}

export { DATA_DIR };
