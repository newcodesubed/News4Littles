import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/** Repo path: /server */
const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Database file location. Override with DATABASE_PATH for tests or alternate envs. */
export const DATABASE_PATH = process.env.DATABASE_PATH
  ? resolve(process.env.DATABASE_PATH)
  : resolve(SERVER_ROOT, 'data', 'news4littles.db');

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
