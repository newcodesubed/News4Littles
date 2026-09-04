/**
 * Scheduled ingestion — PRD §5.3.
 *
 * "Configurable scrape times (e.g. ["06:00"]), driven by a cron-like scheduler
 * (node-cron)." The times come from app_settings.scrapeTimes, seeded to
 * ["06:00"], so an editor can change them from admin settings (§4.4) rather
 * than needing a redeploy.
 *
 * §5.3 does not name a TIMEZONE. Defaults to the server's own zone, overridable
 * with SCRAPE_TIMEZONE in .env — "06:00" has to mean 06:00 somewhere specific.
 */
import cron, { type ScheduledTask } from 'node-cron';
import type { Database } from 'better-sqlite3';
import { SCRAPE_ENABLED, SCRAPE_TIMEZONE } from '../env.js';
import { scrapeAllEnabledSources } from './rssScraper.js';

/** "06:00" -> "0 6 * * *" (every day at 06:00). */
export function timeToCron(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) throw new Error(`Scrape time '${time}' is not HH:MM.`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Scrape time '${time}' is not a real time of day.`);

  return `${minute} ${hour} * * *`;
}

export function readScrapeTimes(db: Database): string[] {
  const row = db.prepare(`SELECT scrapeTimes FROM app_settings WHERE id = 'default'`).get() as
    | { scrapeTimes: string }
    | undefined;

  if (!row) return [];
  try {
    const times = JSON.parse(row.scrapeTimes) as unknown;
    return Array.isArray(times) ? times.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Run one scheduled pass. Never throws — a bad run must not kill the process. */
export async function runScheduledScrape(db: Database): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[scrape] scheduled run starting at ${startedAt}`);

  try {
    const results = await scrapeAllEnabledSources(db);

    for (const result of results) {
      if (result.ok) {
        console.log(
          `[scrape] ${result.sourceId}: ${result.inserted} new, ` +
            `${result.skippedNotNew} already seen, ${result.skippedAlreadyStored} duplicate, ` +
            `${result.skippedUnusable} unusable (of ${result.itemsInFeed} in feed)`,
        );
      } else {
        // Logged, not thrown: one dead feed must not stop the others or the API.
        console.error(`[scrape] ${result.sourceId} FAILED: ${result.error}`);
      }
    }

    if (results.length === 0) console.log('[scrape] no enabled sources with a feed URL.');
  } catch (error: unknown) {
    console.error('[scrape] scheduled run failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Register a cron job per configured scrape time. Returns the tasks so a caller
 * (or a test) can stop them.
 */
export function startScrapeSchedule(db: Database): ScheduledTask[] {
  if (!SCRAPE_ENABLED) {
    console.log('[scrape] scheduler disabled (SCRAPE_ENABLED=false).');
    return [];
  }

  const tasks: ScheduledTask[] = [];

  for (const time of readScrapeTimes(db)) {
    let expression: string;
    try {
      expression = timeToCron(time);
    } catch (error: unknown) {
      console.error(`[scrape] ignoring bad scrape time: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    tasks.push(
      cron.schedule(expression, () => void runScheduledScrape(db), { timezone: SCRAPE_TIMEZONE }),
    );
    console.log(`[scrape] scheduled daily at ${time} (${expression}) — timezone ${SCRAPE_TIMEZONE}`);
  }

  if (tasks.length === 0) console.log('[scrape] no valid scrape times configured.');
  return tasks;
}
