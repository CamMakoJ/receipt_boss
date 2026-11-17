import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(IMAGE_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'receipts.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

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

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const getSetting = (key, fallback = '') => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
