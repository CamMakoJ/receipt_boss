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

const run = promisify(execFile);
const NAME_RE = /^receipt-boss-backup-\d{8}-\d{6}\.zip$/;
const REMOTE_RE = /^[A-Za-z0-9_.-]+:[^\0\r\n]*$/; // rclone "remote:path"

export const backupConfig = () => ({
  enabled: getSetting('backup.enabled', '0') === '1',
  interval_hours: Number(getSetting('backup.interval_hours', '24')),
  keep: Number(getSetting('backup.keep', '14')),
  remote: getSetting('backup.remote', ''),
  copy_dir: getSetting('backup.copy_dir', ''),
});
export const backupStatus = () => ({
  last_at: getSetting('backup.last_at', ''),
  last_ok: getSetting('backup.last_ok', ''),
  last_message: getSetting('backup.last_message', ''),
  running,
});

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const sqlQuote = (s) => `'${s.replace(/'/g, "''")}'`;

/** Create a backup zip at `dest`. Safe while the server is running (uses VACUUM INTO). */
export async function createBackup(dest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-backup-'));
  try {
    const snap = path.join(tmp, 'receipts.db');
    db.exec(`VACUUM INTO ${sqlQuote(snap)}`);
    const copy = new DatabaseSync(snap);
    copy.exec('DELETE FROM sessions'); // never ship login sessions around
    copy.close();

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      const zip = archiver('zip', { zlib: { level: 6 } });
      out.on('close', resolve); out.on('error', reject); zip.on('error', reject);
      zip.pipe(out);
      zip.file(snap, { name: 'receipts.db' });
      if (fs.existsSync(IMAGE_DIR)) zip.directory(IMAGE_DIR, 'images');
      zip.append(JSON.stringify({ app: 'receipt-boss', created: new Date().toISOString(), format: 1 }, null, 2), { name: 'manifest.json' });
      zip.finalize();
    });
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
    const name = `receipt-boss-backup-${stamp()}.zip`;
    const { file, size } = await createBackup(path.join(BACKUP_DIR, name));
    steps.push(`saved ${name} (${(size / 1048576).toFixed(1)} MB)`);

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
    setSetting('backup.enabled', b.enabled ? '1' : '0');
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
    const tmp = path.join(os.tmpdir(), `rb-dl-${process.pid}-${Date.now()}.zip`);
    await createBackup(tmp);
    res.download(tmp, `receipt-boss-backup-${stamp()}.zip`, () => fs.rmSync(tmp, { force: true }));
  }));

  app.get('/api/backup/files/:name', requireAdmin, (req, res) => {
    if (!NAME_RE.test(req.params.name)) throw err(404, 'not found');
    const f = path.join(BACKUP_DIR, req.params.name);
    if (!fs.existsSync(f)) throw err(404, 'not found');
    res.download(f);
  });
}

export { DATA_DIR };
