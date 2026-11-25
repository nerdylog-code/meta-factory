import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applySchema } from './schema.js';

export type Db = BetterSqlite3.Database;

export interface OpenDbOptions {
  /** Absolute path to the SQLite file, or ':memory:'. */
  path: string;
  /** Applied to every pooled connection attempt. */
  busyTimeoutMs?: number;
}

/**
 * Opens (or creates) the factory state database in WAL mode.
 *
 * WAL + foreign_keys are set on EVERY connection: they are per-connection
 * pragmas, so relying on a one-time init would silently lose them.
 */
export function openDb(opts: OpenDbOptions): Db {
  const { path, busyTimeoutMs = 5000 } = opts;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  applySchema(db);
  return db;
}

export function closeDb(db: Db): void {
  if (db.open) db.close();
}

/**
 * Runs `fn` in a `BEGIN IMMEDIATE` transaction.
 *
 * IMMEDIATE takes the write lock up front, which is what makes budget
 * carve-outs race-free: a concurrent writer blocks (busy_timeout) instead of
 * failing at COMMIT with a partially-computed decision.
 */
export function immediate<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}
