/**
 * A consistent copy of the database, taken while the server keeps running.
 *
 *   npm run db:backup     → data/backups/news4littles-<timestamp>.db
 *
 * (backups/ sits beside DATABASE_PATH, wherever that is.)
 *
 * The deploy runs this just before `npm run db:init` migrates the schema, so a
 * bad migration is undone by stopping the server and copying the file back.
 * Keeps the newest ten.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { DATABASE_PATH } from '../src/env.js';

const KEEP = 10;
const BACKUP_DIR = join(dirname(DATABASE_PATH), 'backups');

// The first deploy has no database yet; opening one here would create it empty.
if (!existsSync(DATABASE_PATH)) {
  console.log(`No database at ${DATABASE_PATH} yet; nothing to back up.`);
  process.exit(0);
}

const name = basename(DATABASE_PATH, extname(DATABASE_PATH));
const target = join(BACKUP_DIR, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
mkdirSync(BACKUP_DIR, { recursive: true });

// SQLite's online backup, not a file copy: a copy taken mid-write, or without
// the -wal file beside it, can be missing the latest changes or be corrupt.
const db = openDatabase();
try {
  await db.backup(target);
} finally {
  db.close();
}
console.log(`Backed up ${DATABASE_PATH} to ${target}`);

// ISO timestamps sort by time, so the oldest come first.
const backups = readdirSync(BACKUP_DIR).filter((file) => file.startsWith(`${name}-`) && file.endsWith('.db')).sort();
for (const file of backups.slice(0, -KEEP)) rmSync(join(BACKUP_DIR, file));
