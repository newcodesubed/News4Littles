/**
 * Manual "Run now" scraping — PRD §4.4.
 *
 * A full BBC run is ~35 articles, each one an LLM call, so it can take minutes.
 * Holding an HTTP request open that long invites a proxy timeout, so a run
 * starts in the background and the client polls for its state.
 *
 * Only one run happens at a time. Two concurrent scrapes of the same feed would
 * race on the incremental cursor and could double-insert.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { ConflictError, NotFoundError } from '../core/errors.js';
import { createScrapeRunRepository, type ScrapeTrigger } from '../db/repositories/scrapeRunRepository.js';
import { createSourceRepository } from '../db/repositories/sourceRepository.js';
import { scrapeSource, type ScrapeResult, type SourceRow } from '../ingestion/rssScraper.js';

export interface RunState {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** Sources this run covers, in order. */
  sourceIds: string[];
  /** The source currently being fetched, if any. */
  currentSourceId?: string;
  running: boolean;
  results: ScrapeResult[];
  trigger: ScrapeTrigger;
}

/**
 * Module-level, because the whole app is one process with one admin (§2.2). If
 * this ever runs multiple instances, the lock has to move into the database.
 */
let current: RunState | null = null;

export function getRunState(): RunState | null {
  return current;
}

/** Test seam: forget any in-flight or finished run. */
export function resetRunState(): void {
  current = null;
}

export interface StartOptions {
  sourceId?: string;
  trigger?: ScrapeTrigger;
  /** Caps items per source. A testing aid: see the warning in scripts/scrape.ts. */
  limit?: number;
  /** Awaited by tests and the CLI; the HTTP route does not wait. */
  onFinished?: (state: RunState) => void;
}

/**
 * Begin a run and return immediately. Throws ConflictError if one is already
 * in flight, and NotFoundError for an unknown source.
 */
export function startScrapeRun(db: Database, options: StartOptions = {}): RunState {
  if (current?.running) {
    throw new ConflictError('A scrape is already running. Wait for it to finish before starting another.');
  }

  const sources = createSourceRepository(db);

  let queue: SourceRow[];
  if (options.sourceId) {
    const source = sources.findById(options.sourceId);
    if (!source) throw NotFoundError.of('source', options.sourceId);
    // Running a disabled source by name is allowed: the editor asked for it.
    queue = [source];
  } else {
    queue = sources.listEnabled();
  }

  const state: RunState = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    sourceIds: queue.map((source) => source.id),
    running: true,
    results: [],
    trigger: options.trigger ?? 'manual',
  };
  current = state;

  // Deliberately not awaited: the caller gets the state back straight away.
  void (async () => {
    const runs = createScrapeRunRepository(db);

    for (const source of queue) {
      state.currentSourceId = source.id;
      const startedAt = new Date().toISOString();

      // scrapeSource never throws, but a database failure here would kill the
      // loop and leave `running` true forever.
      let result: ScrapeResult;
      try {
        result = await scrapeSource(db, source, { limit: options.limit });
      } catch (error: unknown) {
        result = {
          sourceId: source.id, sourceName: source.name, ok: false,
          error: error instanceof Error ? error.message : String(error),
          itemsInFeed: 0, skippedNotNew: 0, skippedAlreadyStored: 0, skippedUnusable: 0,
          inserted: 0, newestItemPublishedAt: source.lastFetchedItemPublishedAt,
          stored: [], costUsd: 0, fallbacks: [],
        };
      }

      state.results.push(result);
      try {
        runs.record(result, { startedAt, finishedAt: new Date().toISOString(), trigger: state.trigger });
      } catch (error: unknown) {
        console.error('[scrape] could not record the run:', error);
      }
    }

    state.currentSourceId = undefined;
    state.finishedAt = new Date().toISOString();
    state.running = false;
    options.onFinished?.(state);
  })();

  return state;
}

/** Totals for the UI. */
export function summarise(state: RunState) {
  return {
    inserted: state.results.reduce((total, r) => total + r.inserted, 0),
    failed: state.results.filter((r) => !r.ok).length,
    costUsd: state.results.reduce((total, r) => total + r.costUsd, 0),
  };
}
