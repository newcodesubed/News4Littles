import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { DATABASE_PATH } from '../env.js';

// Re-exported so db modules have a single import for "open a connection".
// Configured in .env — see .env.example.
export { DATABASE_PATH };

/**
 * Open a connection with the pragmas this schema depends on.
 *
 * foreign_keys is OFF by default in SQLite and is a per-connection setting, so
 * every connection must enable it or the FK constraints in schema.sql are inert.
 */
export function openDatabase(path: string = DATABASE_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
