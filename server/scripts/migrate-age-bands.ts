/**
 * Collapse one-version-per-age stories onto the three reading bands.
 *
 *   npm run db:migrate-age-bands            # dry run: print what would change
 *   npm run db:migrate-age-bands -- --apply # do it
 *
 * Deletes the surplus rows a pre-band story holds, so it never writes without
 * --apply. Safe to re-run: a migrated database reports nothing to do.
 */
import { openDatabase, DATABASE_PATH } from '../src/db/connection.js';
import { ANCHOR_LIST, migrateAgeBands } from '../src/db/migrateAgeBands.js';

const apply = process.argv.includes('--apply');
const db = openDatabase();

try {
  const report = migrateAgeBands(db, { apply });

  console.log(`Database: ${DATABASE_PATH}`);
  console.log(`Band anchors: ${ANCHOR_LIST}\n`);
  console.log(`  stories affected      ${report.storiesChanged}`);
  console.log(`  versions re-labelled  ${report.rowsMoved.length}`);
  console.log(`  versions deleted      ${report.rowsDeleted.length}`);
  console.log(`  overrides re-keyed    ${report.overridesMoved.map((m) => `${m.from}->${m.to}`).join(', ') || 0}`);
  console.log(`  overrides dropped     ${report.overridesDropped.join(', ') || 0}`);
  console.log(`  drafts re-keyed       ${report.draftsMoved.map((m) => `${m.from}->${m.to}`).join(', ') || 0}`);
  console.log(`  drafts dropped        ${report.draftsDropped.join(', ') || 0}`);
  console.log(`  default reading age   ${
    report.defaultAgeMoved ? `${report.defaultAgeMoved.from}->${report.defaultAgeMoved.to}` : 'already a band'
  }`);

  const nothing =
    report.storiesChanged === 0 && report.overridesMoved.length === 0 &&
    report.overridesDropped.length === 0 && report.draftsMoved.length === 0 &&
    report.draftsDropped.length === 0 && report.defaultAgeMoved === undefined;

  if (nothing) console.log('\nNothing to do.');
  else if (apply) console.log('\nApplied.');
  else console.log('\nDry run — nothing was written. Re-run with --apply to make these changes.');
} finally {
  db.close();
}
