/**
 * SQLite database layer for activity event logging.
 *
 * Lazy-initialized singleton. Opens on first call to getDb(), never on import.
 * Returns null if better-sqlite3 is unavailable (native build failure, optional dep).
 * WAL mode + busy_timeout for multi-process concurrent access.
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAoBaseDir } from "./paths.js";

const _require = createRequire(import.meta.url);

type BetterSqlite3Database = {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};

let _db: BetterSqlite3Database | null = null;
let _dbFailed = false;
let _ftsEnabled = false;
const PRUNE_BATCH_SIZE = 1000;

function getEventsDbPath(): string {
  return join(getAoBaseDir(), "activity-events.db");
}

function initSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_epoch   INTEGER NOT NULL,
      ts         TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      source     TEXT NOT NULL,
      type       TEXT NOT NULL,
      log_level  TEXT NOT NULL DEFAULT 'info',
      summary    TEXT NOT NULL,
      data       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ae_ts      ON activity_events(ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_ae_session ON activity_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_ae_project ON activity_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_ae_type    ON activity_events(type);
    CREATE INDEX IF NOT EXISTS idx_ae_source  ON activity_events(source);
  `);
}

function initFts(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS activity_events_fts USING fts5(
      summary, data,
      content='activity_events',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS activity_events_ai
      AFTER INSERT ON activity_events
    BEGIN
      INSERT INTO activity_events_fts(rowid, summary, data)
        VALUES (new.id, new.summary, new.data);
    END;

    CREATE TRIGGER IF NOT EXISTS activity_events_ad
      AFTER DELETE ON activity_events
    BEGIN
      INSERT INTO activity_events_fts(activity_events_fts, rowid, summary, data)
        VALUES ('delete', old.id, old.summary, old.data);
    END;

    CREATE TRIGGER IF NOT EXISTS activity_events_au
      AFTER UPDATE ON activity_events
    BEGIN
      INSERT INTO activity_events_fts(activity_events_fts, rowid, summary, data)
        VALUES ('delete', old.id, old.summary, old.data);
      INSERT INTO activity_events_fts(rowid, summary, data)
        VALUES (new.id, new.summary, new.data);
    END;
  `);

  db.exec("INSERT INTO activity_events_fts(activity_events_fts) VALUES('rebuild')");
}

function pruneOldEvents(db: BetterSqlite3Database, cutoff: number): void {
  db
    .prepare(
      `DELETE FROM activity_events
       WHERE rowid IN (
         SELECT rowid FROM activity_events WHERE ts_epoch < ? LIMIT ?
       )`,
    )
    .run(cutoff, PRUNE_BATCH_SIZE);
}

function openDb(): BetterSqlite3Database {
  const Database = _require("better-sqlite3") as new (path: string) => BetterSqlite3Database;
  mkdirSync(getAoBaseDir(), { recursive: true });
  const db = new Database(getEventsDbPath());

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.pragma("synchronous = NORMAL");

  const version = db.pragma("user_version", { simple: true }) as number;
  initSchema(db);
  if (version < 1) {
    db.pragma("user_version = 1");
  }

  try {
    initFts(db);
    _ftsEnabled = true;
  } catch (err) {
    _ftsEnabled = false;
    process.stderr.write(
      `[ao] activity-events FTS unavailable — writes will continue and search will use a bounded LIKE fallback: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  pruneOldEvents(db, cutoff);

  return db;
}

export function isActivityEventsFtsEnabled(): boolean {
  return _ftsEnabled;
}

export function getDb(): BetterSqlite3Database | null {
  if (_dbFailed) return null;
  if (_db) return _db;
  try {
    _db = openDb();
    return _db;
  } catch (err) {
    _dbFailed = true;
    process.stderr.write(
      `[ao] activity-events DB unavailable — events will be dropped: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return null;
  }
}
