import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { openDb } from '../src/db/client.js';
import { ALL_TABLES } from '../src/db/drizzle-schema.js';

/**
 * The database has two definitions: the hand-written DDL in `schema.ts` (which
 * creates it, including CHECK constraints and pragmas) and the Drizzle schema
 * (which types it). Those must not drift — a column added to one and not the
 * other is a silent corruption waiting to happen.
 *
 * This test reads the real SQLite schema after `openDb` and compares it column
 * for column with what Drizzle believes.
 */
describe('drizzle schema matches the database', () => {
  const db = openDb({ path: ':memory:' });
  const actual = new Map<string, Array<{ name: string; type: string; notnull: number; pk: number }>>();
  for (const { name } of db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(name).replace(/"/g, "'")})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    actual.set(name, cols);
  }

  it('every Drizzle table exists in the database', () => {
    for (const [key, table] of Object.entries(ALL_TABLES)) {
      const { name } = getTableConfig(table);
      expect(actual.has(name), `table '${name}' from drizzle (${key}) is missing in the db`).toBe(true);
    }
  });

  it('every database table is described by Drizzle', () => {
    const drizzleTables = new Set(Object.values(ALL_TABLES).map((t) => getTableConfig(t).name));
    for (const name of actual.keys()) {
      expect(drizzleTables.has(name), `table '${name}' exists in the db but not in drizzle-schema.ts`).toBe(true);
    }
  });

  it('column names match in both directions for every table', () => {
    for (const table of Object.values(ALL_TABLES)) {
      const cfg = getTableConfig(table);
      const dbCols = actual.get(cfg.name);
      expect(dbCols, `table '${cfg.name}' missing`).toBeDefined();

      const drizzleCols = cfg.columns.map((c) => c.name).sort();
      const sqliteCols = dbCols!.map((c) => c.name).sort();
      expect(drizzleCols, `column mismatch in '${cfg.name}'`).toEqual(sqliteCols);
    }
  });

  it('reports a mismatch instead of passing silently (self-check of the test)', () => {
    // If the comparison above were vacuous (e.g. both sides empty), these
    // assertions would pass for a nonexistent table. Prove it compares.
    const cfg = getTableConfig(ALL_TABLES.tokenLedger);
    expect(cfg.columns.length).toBeGreaterThan(10);
    expect(actual.get('token_ledger')!.length).toBe(cfg.columns.length);
  });
});
