/**
 * Upgrade the stored translation prompts to the current seeded text, and say
 * what was found.
 *
 *   npm run db:update-prompts
 *
 * `npm run db:seed` is deliberately ON CONFLICT DO NOTHING so it can never
 * overwrite an editor's work, which means an improved seeded prompt would never
 * reach an existing database. `npm run db:init` now does the same refresh on
 * every run; this script exists to do it on its own and to report the state of
 * each prompt. The rule is in src/db/refreshSeededPrompts.ts: only a prompt that
 * is exactly an older seed is replaced; a customised or removed one is left.
 */
import { openDatabase, DATABASE_PATH } from '../src/db/connection.js';
import { refreshSeededPrompts, type SeededPromptState } from '../src/db/refreshSeededPrompts.js';

const DESCRIBE: Record<SeededPromptState, string> = {
  current: 'already current',
  refreshed: 'updated from an older seed',
  customised: 'customised — left untouched',
  absent: 'absent — left untouched',
};

const db = openDatabase();

try {
  const report = refreshSeededPrompts(db);

  console.log(`Database: ${DATABASE_PATH}\n`);
  console.log(`  generic prompt        ${DESCRIBE[report.generic]}`);
  console.log(`  ages 5-7 override     ${DESCRIBE[report.youngReaders]}`);

  const states = [report.generic, report.youngReaders];
  if (states.includes('refreshed')) {
    console.log('\nUpdated. The new wording applies to the next simplification.');
  } else {
    console.log('\nNothing to do.');
  }
  if (states.includes('customised')) {
    console.log('A customised prompt was left untouched. To adopt the current wording,');
    console.log('edit it in /admin/settings — the seeded text is in src/db/seed-prompts.ts.');
  }
} finally {
  db.close();
}
