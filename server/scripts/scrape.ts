/**
 * Manual "Run now" trigger — PRD §5.3.
 *
 *   npm run scrape            all enabled sources
 *   npm run scrape:bbc        just BBC
 *   npm run scrape -- --limit 5      cap items, for testing
 *   npm run scrape -- --source npr
 *
 * Runs one pass and exits. Exits non-zero if any source failed, so it is safe
 * to use in a check.
 */
import { openDatabase } from '../src/db/connection.js';
import type { ScrapeResult } from '../src/ingestion/rssScraper.js';
import { startScrapeRun, type RunState } from '../src/services/scrapeService.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function report(result: ScrapeResult): void {
  console.log('─'.repeat(78));
  console.log(`${result.sourceName} (${result.sourceId})`);
  console.log('─'.repeat(78));

  if (!result.ok) {
    console.error(`  FAILED: ${result.error}`);
    console.error('  Nothing was written; the incremental cursor did not move.');
    return;
  }

  console.log(`  items in feed        ${result.itemsInFeed}`);
  console.log(`  skipped (not new)    ${result.skippedNotNew}`);
  console.log(`  skipped (duplicate)  ${result.skippedAlreadyStored}`);
  console.log(`  skipped (unusable)   ${result.skippedUnusable}`);
  console.log(`  INSERTED             ${result.inserted}`);
  console.log(`  cursor now at        ${result.newestItemPublishedAt ?? '(none)'}`);

  if (result.stored.length > 0) {
    console.log('\n  Stored as pending_review:');
    for (const item of result.stored) {
      console.log(`    [${item.safety.padEnd(12)}] ${item.kidHeadline}`);
    }
  }
}

async function main(): Promise<void> {
  const db = openDatabase();

  try {
    const limitArg = flag('limit');
    const limit = limitArg === undefined ? undefined : Number(limitArg);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new Error(`--limit must be a whole number, got '${limitArg}'.`);
    }

    const sourceId = flag('source');

    // Shares the service the admin "Run now" button uses, so a CLI scrape is
    // recorded in scrape_runs and shows up as the last run in admin settings.
    const state = await new Promise<RunState>((resolve, reject) => {
      try {
        startScrapeRun(db, { sourceId, limit, trigger: 'manual', onFinished: resolve });
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const results: ScrapeResult[] = state.results;

    if (results.length === 0) {
      console.log('No enabled sources with a feed URL. Enable one in the sources table.');
      return;
    }

    for (const result of results) report(result);

    const inserted = results.reduce((total, r) => total + r.inserted, 0);
    const failed = results.filter((r) => !r.ok);

    console.log('─'.repeat(78));
    console.log(`Total inserted: ${inserted}   Sources failed: ${failed.length}`);
    console.log('All new articles are status = pending_review (§5.2 step 7).');

    if (failed.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error('Scrape failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
