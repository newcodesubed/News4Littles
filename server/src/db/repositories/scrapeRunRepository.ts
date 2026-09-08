/** Run history for §4.4's "last-run results". */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ScrapeResult } from '../../ingestion/rssScraper.js';

export type ScrapeTrigger = 'manual' | 'scheduled';

export interface ScrapeRun {
  id: string;
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error: string | null;
  itemsInFeed: number;
  inserted: number;
  skippedNotNew: number;
  skippedAlreadyStored: number;
  skippedUnusable: number;
  costUsd: number;
  fallbacks: string[];
  trigger: ScrapeTrigger;
}

interface ScrapeRunRow extends Omit<ScrapeRun, 'ok' | 'fallbacks'> {
  ok: number;
  fallbacks: string;
}

function toScrapeRun(row: ScrapeRunRow): ScrapeRun {
  return {
    ...row,
    ok: row.ok === 1,
    fallbacks: JSON.parse(row.fallbacks) as string[],
  };
}

export interface ScrapeRunRepository {
  record(result: ScrapeResult, meta: { startedAt: string; finishedAt: string; trigger: ScrapeTrigger }): ScrapeRun;
  /** The newest run per source — what the settings page shows. */
  latestPerSource(): Record<string, ScrapeRun>;
  listForSource(sourceId: string, limit?: number): ScrapeRun[];
}

export function createScrapeRunRepository(db: Database): ScrapeRunRepository {
  const insert = db.prepare(
    `INSERT INTO scrape_runs
       (id, sourceId, startedAt, finishedAt, ok, error, itemsInFeed, inserted,
        skippedNotNew, skippedAlreadyStored, skippedUnusable, costUsd, fallbacks, trigger)
     VALUES
       (@id, @sourceId, @startedAt, @finishedAt, @ok, @error, @itemsInFeed, @inserted,
        @skippedNotNew, @skippedAlreadyStored, @skippedUnusable, @costUsd, @fallbacks, @trigger)`,
  );

  /** One row per source: the newest by finishedAt. */
  const latest = db.prepare(
    `SELECT r.* FROM scrape_runs r
     JOIN (SELECT sourceId, MAX(finishedAt) AS newest FROM scrape_runs GROUP BY sourceId) latest
       ON latest.sourceId = r.sourceId AND latest.newest = r.finishedAt
     GROUP BY r.sourceId`,
  );

  const forSource = db.prepare(
    `SELECT * FROM scrape_runs WHERE sourceId = ? ORDER BY finishedAt DESC LIMIT ?`,
  );

  return {
    record(result, meta) {
      const run: ScrapeRun = {
        id: randomUUID(),
        sourceId: result.sourceId,
        startedAt: meta.startedAt,
        finishedAt: meta.finishedAt,
        ok: result.ok,
        error: result.error ?? null,
        itemsInFeed: result.itemsInFeed,
        inserted: result.inserted,
        skippedNotNew: result.skippedNotNew,
        skippedAlreadyStored: result.skippedAlreadyStored,
        skippedUnusable: result.skippedUnusable,
        costUsd: result.costUsd,
        fallbacks: result.fallbacks,
        trigger: meta.trigger,
      };

      insert.run({ ...run, ok: run.ok ? 1 : 0, fallbacks: JSON.stringify(run.fallbacks) });
      return run;
    },

    latestPerSource: () =>
      Object.fromEntries(
        (latest.all() as ScrapeRunRow[]).map((row) => [row.sourceId, toScrapeRun(row)]),
      ),

    listForSource: (sourceId, limit = 10) =>
      (forSource.all(sourceId, limit) as ScrapeRunRow[]).map(toScrapeRun),
  };
}
