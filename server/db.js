import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
// Everything here is private: receipts, photos, password hashes, backups. Owner-only permissions (best effort on non-POSIX systems).
for (const dir of [DATA_DIR, IMAGE_DIR]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not supported / not owner */ }
}

export const DB_PATH = path.join(DATA_DIR, 'receipts.db');
export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;      -- wait for a lock instead of failing (backups and requests overlap)
  PRAGMA synchronous = NORMAL;     -- safe with WAL; far fewer fsyncs
`);
for (const ext of ['', '-wal', '-shm']) { try { fs.chmodSync(DB_PATH + ext, 0o600); } catch { /* file may not exist yet */ } }

// ---- v1 schema (original release)
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    gst_rate REAL NOT NULL DEFAULT 5, pst_rate REAL NOT NULL DEFAULT 7,
    next_number INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    client_id TEXT UNIQUE, number INTEGER NOT NULL, date TEXT NOT NULL,
    vendor TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    subtotal INTEGER NOT NULL DEFAULT 0, gst INTEGER NOT NULL DEFAULT 0, pst INTEGER NOT NULL DEFAULT 0, tip INTEGER NOT NULL DEFAULT 0,
    billable INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '', image TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (project_id, number)
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_project ON receipts(project_id, number);
`);

// ---- migrations
const version = () => db.prepare('PRAGMA user_version').get().user_version;
if (version() < 2) {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')), created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE items (               -- household purchases tracked for warranty; shared by all accounts
        id INTEGER PRIMARY KEY, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, client_id TEXT UNIQUE,
        name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', purchase_date TEXT NOT NULL,
        vendor TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, warranty_months INTEGER,
        serial TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', image TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ALTER TABLE projects ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE projects ADD COLUMN province TEXT NOT NULL DEFAULT 'BC';
      ALTER TABLE projects DROP COLUMN gst_rate;
      ALTER TABLE projects DROP COLUMN pst_rate;
      ALTER TABLE receipts ADD COLUMN province TEXT NOT NULL DEFAULT 'BC';
      ALTER TABLE receipts ADD COLUMN category TEXT NOT NULL DEFAULT '';
      ALTER TABLE receipts ADD COLUMN tax_auto INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_projects_user ON projects(user_id);
    `);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

if (version() < 3) {
  db.exec('BEGIN');
  try {
    db.exec(`
      ALTER TABLE receipts ADD COLUMN ocr_text TEXT NOT NULL DEFAULT '';          -- text read from the photo (search + AI check)
      ALTER TABLE receipts ADD COLUMN check_status TEXT NOT NULL DEFAULT 'none';  -- none | pending | ok | review | error | reviewed
      ALTER TABLE receipts ADD COLUMN check_json TEXT NOT NULL DEFAULT '';
      ALTER TABLE receipts ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'unbilled'; -- unbilled | invoiced | paid (billable receipts)
      ALTER TABLE receipts ADD COLUMN invoice_ref TEXT NOT NULL DEFAULT '';
      ALTER TABLE receipts ADD COLUMN invoiced_at TEXT;
      ALTER TABLE items ADD COLUMN ocr_text TEXT NOT NULL DEFAULT '';
    `);
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

if (version() < 4) {
  db.exec('BEGIN');
  try {
    db.exec(`
      -- several photos per receipt / item (AUTOINCREMENT: ids are never reused, so cached /photos/:id URLs can never show a different image). receipts.image and items.image stay as the "cover" (first photo) so older code paths keep working.
      CREATE TABLE receipt_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE, file TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX idx_receipt_photos ON receipt_photos(receipt_id, position);
      CREATE TABLE item_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, file TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX idx_item_photos ON item_photos(item_id, position);
      INSERT INTO receipt_photos (receipt_id, file, position) SELECT id, image, 0 FROM receipts WHERE image IS NOT NULL;
      INSERT INTO item_photos (item_id, file, position) SELECT id, image, 0 FROM items WHERE image IS NOT NULL;
      -- quick-capture drafts: kept out of totals, reports, duplicate checks and AI checks until reviewed (their number is -id until then)
      ALTER TABLE receipts ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
    `);
    db.exec('PRAGMA user_version = 4');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

if (version() < 5) {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_receipts_project_draft ON receipts(project_id, draft, number);
      CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);                       -- duplicate lookups
      CREATE INDEX IF NOT EXISTS idx_receipts_pending ON receipts(check_status) WHERE check_status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_items_date ON items(purchase_date);
    `);
    db.exec('PRAGMA user_version = 5');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Side effects on files must follow the database outcome: delete files only after COMMIT, discard new files on ROLLBACK.
let txDepth = 0, commitHooks = [], rollbackHooks = [];
export const afterCommit = (fn) => (txDepth ? commitHooks.push(fn) : fn());
export const onRollback = (fn) => { if (txDepth) rollbackHooks.push(fn); };
const run = (hooks) => hooks.forEach((h) => { try { h(); } catch { /* best-effort cleanup */ } });

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    txDepth--; const hooks = commitHooks; commitHooks = []; rollbackHooks = [];
    run(hooks);
    return r;
  } catch (e) {
    txDepth--; const hooks = rollbackHooks; commitHooks = []; rollbackHooks = [];
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    run(hooks);
    throw e;
  }
}

export const getSetting = (key, fallback = '') => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

/** 'ok' or a description of the problem. quick_check is fast enough to run at every start. */
export const quickCheck = () => db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]).join('; ');

/** Flush the write-ahead log into the main file and let SQLite refresh its query statistics. */
export function maintain() {
  db.exec('PRAGMA optimize');
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}
export function closeDb() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* already closed */ }
}
