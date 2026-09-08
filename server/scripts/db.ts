/**
 * Read-only look at the database.
 *
 *   npm run db                          list every table with a row count
 *   npm run db -- sources               dump one table
 *   npm run db -- kid_articles 5        dump one table, first 5 rows
 *   npm run db -- "SELECT ..."          run any read-only SQL
 *
 * Opens through openDatabase() so the WAL file is read too — a GUI pointed at
 * news4littles.db alone can show stale data while a -wal file is sitting next
 * to it. Writes are refused: this is for looking, not for fixing.
 */
import { openDatabase } from '../src/db/connection.js';

const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|VACUUM|ATTACH|PRAGMA)\b/i;

/** Long text and JSON blobs are trimmed so one wide row does not fill the screen. */
function trim(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= 120) return value;
  return `${value.slice(0, 120)}… (${value.length} chars)`;
}

/**
 * Closest candidate by edit distance, or undefined if nothing is close enough.
 * Only needs to catch typos, so a plain Levenshtein is plenty.
 */
function nearest(word: string, candidates: string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    return previous[b.length];
  };

  const ranked = candidates
    .map((candidate) => ({ candidate, score: distance(word.toLowerCase(), candidate.toLowerCase()) }))
    .sort((a, b) => a.score - b.score)[0];

  return ranked && ranked.score <= Math.max(2, Math.floor(word.length / 3))
    ? ranked.candidate
    : undefined;
}

function show(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  console.table(rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, trim(value)]),
  )));
  console.log(`${rows.length} row(s)`);
}

function main(): void {
  const db = openDatabase();
  const [argument, limitArgument] = process.argv.slice(2);

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];

  // No argument: the overview.
  if (!argument) {
    show(tables.map(({ name }) => ({
      table: name,
      rows: (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
    })));
    console.log('\nnpm run db -- <table> [limit]   dump a table');
    console.log('npm run db -- "SELECT ..."      run read-only SQL');
    return;
  }

  // A bare table name is a convenience for the SELECT everyone types anyway.
  if (tables.some(({ name }) => name === argument)) {
    const limit = Number(limitArgument ?? 20);
    show(db.prepare(`SELECT * FROM "${argument}" LIMIT ?`).all(Number.isFinite(limit) ? limit : 20) as Record<string, unknown>[]);
    return;
  }

  if (WRITE_KEYWORDS.test(argument)) {
    console.error('Refused: this script is read-only. Use a migration or the admin API to change data.');
    process.exitCode = 1;
    return;
  }

  // A typo in a table name is the common mistake here, so report it as one line
  // with a suggestion rather than a stack trace through better-sqlite3.
  try {
    show(db.prepare(argument).all() as Record<string, unknown>[]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`SQL error: ${message}`);

    const missing = /no such table: (\w+)/.exec(message)?.[1];
    const suggestion = missing && nearest(missing, tables.map(({ name }) => name));
    if (suggestion) console.error(`Did you mean "${suggestion}"?`);
    else if (missing) console.error(`Tables: ${tables.map(({ name }) => name).join(', ')}`);

    process.exitCode = 1;
  }
}

main();
