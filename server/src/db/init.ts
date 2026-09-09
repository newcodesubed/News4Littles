/**
 * Creates every table defined in schema.sql. Idempotent — safe to re-run.
 * Seeds nothing.
 *
 *   npm run db:init
 *   DATABASE_PATH=/tmp/test.db npm run db:init
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { DATABASE_PATH, openDatabase } from './connection.js';

/**
 * Bumped whenever schema.sql changes in a way an existing database must migrate
 * to. Every statement in schema.sql is CREATE ... IF NOT EXISTS, so re-running
 * `npm run db:init` adds new tables to an existing database without touching
 * the data already in it. Added COLUMNS need the ALTER pass below.
 *
 * 2 — added scrape_runs (§4.4 last-run results).
 * 3 — added raw_articles.simplifiedAt, app_settings.simplifyBudget and the
 *     scrape_runs simplification counts (the per-run simplification budget).
 * 4 — added scrape_runs.versions (one story now yields one version per age).
 */
export const SCHEMA_VERSION = 4;

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * Columns added to tables that already existed in an earlier version.
 * ALTER TABLE ADD COLUMN is the only way to reach a database that already has
 * rows; schema.sql's CREATE ... IF NOT EXISTS cannot alter an existing table.
 *
 * Verified against the pinned better-sqlite3 (SQLite 3.49.2): ADD COLUMN
 * accepts NOT NULL with a non-NULL DEFAULT plus a CHECK, and backfills existing
 * rows with the default.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'raw_articles', column: 'simplifiedAt', definition: 'TEXT' },
  {
    table: 'app_settings',
    column: 'simplifyBudget',
    definition: 'INTEGER NOT NULL DEFAULT 10 CHECK (simplifyBudget BETWEEN 0 AND 100)',
  },
  { table: 'scrape_runs', column: 'simplified', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'scrape_runs', column: 'leftWaiting', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // No backfill: a run recorded before this change genuinely had one version
  // per story, and 0 is a truthful "not measured" rather than a wrong number.
  { table: 'scrape_runs', column: 'versions', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

/**
 * Runs BEFORE schema.sql, because schema.sql creates an index over
 * simplifiedAt and that fails on a database where the column is still missing.
 * A table that does not exist yet reports no columns, so a fresh database skips
 * every entry and gets the columns from CREATE TABLE instead.
 */
function addMissingColumns(db: Database): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    if (columns.length === 0) continue;
    if (columns.some((existing) => existing.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function initialiseSchema(path: string = DATABASE_PATH): string[] {
  const db = openDatabase(path);

  try {
    const previousVersion = db.pragma('user_version', { simple: true }) as number;
    if (previousVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database at ${path} is schema version ${previousVersion}, but this code understands ` +
          `version ${SCHEMA_VERSION}. Refusing to run against a newer database.`,
      );
    }

    addMissingColumns(db);
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

    // Before v3 every stored raw was simplified the moment it was stored, so a
    // NULL here means "migrated", not "waiting". Guarded on the version read
    // above: running this on a v3 database would stamp the real backlog as
    // simplified and lose it.
    if (previousVersion > 0 && previousVersion < 3) {
      db.exec(`UPDATE raw_articles SET simplifiedAt = fetchedAt WHERE simplifiedAt IS NULL`);
    }

    db.pragma(`user_version = ${SCHEMA_VERSION}`);

    return db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .pluck()
      .all() as string[];
  } finally {
    db.close();
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const tables = initialiseSchema();
  console.log(`Database ready at ${DATABASE_PATH} (schema version ${SCHEMA_VERSION})`);
  console.log(`${tables.length} tables:`);
  for (const table of tables) console.log(`  - ${table}`);
}
