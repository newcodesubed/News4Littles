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
import { logger } from '../logger.js';
import { startScrapeRun, type RunState } from '../services/scrapeService.js';

const log = logger.child({ area: 'scrape' });

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
  log.info('scheduled run starting');

  try {
    // Shares the manual path, so a scheduled run is recorded in scrape_runs and
    // cannot collide with one an editor started (§4.4).
    const state = await new Promise<RunState>((resolve) => {
      startScrapeRun(db, { trigger: 'scheduled', onFinished: resolve });
    });
    const results = state.results;

    for (const result of results) {
      if (result.ok) {
        log.info(
          {
            sourceId: result.sourceId,
            stored: result.inserted,
            simplified: result.simplified.length,
            versions: result.versionsCreated,
            waiting: result.leftWaiting,
            alreadySeen: result.skippedNotNew,
            duplicate: result.skippedAlreadyStored,
            unusable: result.skippedUnusable,
            inFeed: result.itemsInFeed,
          },
          'source scraped',
        );
      } else {
        // Logged, not thrown: one dead feed must not stop the others or the API.
        log.error({ sourceId: result.sourceId, reason: result.error }, 'source failed');
      }
    }

    if (results.length === 0) log.info('no enabled sources with a feed URL');
  } catch (error: unknown) {
    log.error({ err: error }, 'scheduled run failed');
  }
}

/**
 * Register a cron job per configured scrape time. Returns the tasks so a caller
 * (or a test) can stop them.
 */
export function startScrapeSchedule(db: Database): ScheduledTask[] {
  if (!SCRAPE_ENABLED) {
    log.info('scheduler disabled (SCRAPE_ENABLED=false)');
    return [];
  }

  const tasks: ScheduledTask[] = [];

  for (const time of readScrapeTimes(db)) {
    let expression: string;
    try {
      expression = timeToCron(time);
    } catch (error: unknown) {
      log.error({ err: error, time }, 'ignoring bad scrape time');
      continue;
    }

    tasks.push(
      cron.schedule(expression, () => void runScheduledScrape(db), { timezone: SCRAPE_TIMEZONE }),
    );
    log.info({ time, expression, timezone: SCRAPE_TIMEZONE }, 'scheduled daily');
  }

  if (tasks.length === 0) log.info('no valid scrape times configured');
  return tasks;
}
