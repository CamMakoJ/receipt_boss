import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGE_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'receipts.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    client      TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    gst_rate    REAL NOT NULL DEFAULT 5,   -- percent, used to pre-fill the form
    pst_rate    REAL NOT NULL DEFAULT 7,
    next_number INTEGER NOT NULL DEFAULT 1, -- receipt numbers are never reused
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    client_id   TEXT UNIQUE,               -- idempotency key for offline sync
    number      INTEGER NOT NULL,          -- per-project receipt number
    date        TEXT NOT NULL,             -- YYYY-MM-DD
    vendor      TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    subtotal    INTEGER NOT NULL DEFAULT 0, -- all money is integer cents
    gst         INTEGER NOT NULL DEFAULT 0,
    pst         INTEGER NOT NULL DEFAULT 0,
    tip         INTEGER NOT NULL DEFAULT 0,
    billable    INTEGER NOT NULL DEFAULT 1,
    notes       TEXT NOT NULL DEFAULT '',
    image       TEXT,                       -- file name inside IMAGE_DIR
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, number)
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_project ON receipts(project_id, number);
`);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
