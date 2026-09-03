/**
 * Creates every table defined in schema.sql. Idempotent — safe to re-run.
 * Seeds nothing.
 *
 *   npm run db:init
 *   DATABASE_PATH=/tmp/test.db npm run db:init
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATABASE_PATH, openDatabase } from './connection.js';

/** Bumped whenever schema.sql changes in a way an existing database must migrate to. */
export const SCHEMA_VERSION = 1;

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

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

    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
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
