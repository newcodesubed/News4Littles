/**
 * A scrape run — PRD §4.4 "Run now", §5.3 scheduled.
 *
 * Two phases, because §5.2's single pass over every item cost 40-50 LLM calls
 * for a queue an editor triages ten of:
 *
 *   1. fetching     every enabled source is fetched and everything new stored
 *                   as a raw article. Cheap, unbounded, nothing is dropped.
 *   2. simplifying  a budget of app_settings.simplifyBudget articles is spent
 *                   round-robin across sources, newest first. The rest wait.
 *
 * A run starts in the background and the client polls for its state: holding an
 * HTTP request open for minutes invites a proxy timeout.
 *
 * One background job at a time, shared with manual simplification via jobLock —
 * two writers turning the same raw rows into kid articles could double-insert.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { NotFoundError } from '../core/errors.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import {
  createScrapeRunRepository, type ScrapeTrigger,
} from '../db/repositories/scrapeRunRepository.js';
import { createSettingsRepository } from '../db/repositories/settingsRepository.js';
import { createSourceRepository } from '../db/repositories/sourceRepository.js';
import { scrapeSource, type ScrapeResult, type SourceRow } from '../ingestion/rssScraper.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import { acquireJob, releaseJob } from './jobLock.js';
import { selectBudgetedBatch, type SourceQueue } from './simplifyBudget.js';
import { simplifyRawArticles } from './simplifyService.js';

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
  /** Which half of the run is happening, so the UI can say which. */
  phase: 'fetching' | 'simplifying';
  /** The budget this run is spending. */
  budget: number;
  /** How many of the batch have been simplified so far. */
  simplifiedCount: number;
}

let current: RunState | null = null;

export function getRunState(): RunState | null {
  return current;
}

/** Test seam: forget any in-flight or finished run and let go of the lock. */
export function resetRunState(): void {
  current = null;
  releaseJob();
}

export interface StartOptions {
  sourceId?: string;
  trigger?: ScrapeTrigger;
  /**
   * Caps items FETCHED per source, discarding the rest. A testing aid: see the
   * warning in scripts/scrape.ts. Distinct from `budget`, which only defers.
   */
  limit?: number;
  /** Overrides app_settings.simplifyBudget. A test seam. */
  budget?: number;
  /** Passed through to simplification; tests and the sandbox use it. */
  client?: OpenRouterClient;
  /** Awaited by tests and the CLI; the HTTP route does not wait. */
  onFinished?: (state: RunState) => void;
}

function failedResult(source: SourceRow, error: unknown): ScrapeResult {
  return {
    sourceId: source.id,
    sourceName: source.name,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    itemsInFeed: 0,
    skippedNotNew: 0,
    skippedAlreadyStored: 0,
    skippedUnusable: 0,
    inserted: 0,
    newestItemPublishedAt: source.lastFetchedItemPublishedAt,
    stored: [],
    simplified: [],
    leftWaiting: 0,
    costUsd: 0,
    fallbacks: [],
  };
}

/**
 * Begin a run and return immediately. Throws ConflictError if a scrape or a
 * manual simplification is already in flight, and NotFoundError for an unknown
 * source.
 */
export function startScrapeRun(db: Database, options: StartOptions = {}): RunState {
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

  // After the source lookup, so a typo'd source id does not take the lock.
  acquireJob('scrape');

  const state: RunState = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    sourceIds: queue.map((source) => source.id),
    running: true,
    results: [],
    trigger: options.trigger ?? 'manual',
    phase: 'fetching',
    budget: 0,
    simplifiedCount: 0,
  };
  current = state;

  // Deliberately not awaited: the caller gets the state back straight away.
  void (async () => {
    const runs = createScrapeRunRepository(db);
    const raws = createRawArticleRepository(db);
    const timings = new Map<string, { startedAt: string; finishedAt: string }>();

    try {
      // ─── Phase 1: fetch and store. Cheap, and nothing is discarded. ─────
      for (const source of queue) {
        state.currentSourceId = source.id;
        const startedAt = new Date().toISOString();

        // scrapeSource never throws, but a database failure here would kill
        // the loop, so it is caught rather than trusted.
        let result: ScrapeResult;
        try {
          result = await scrapeSource(db, source, { limit: options.limit });
        } catch (error: unknown) {
          result = failedResult(source, error);
        }

        state.results.push(result);
        timings.set(source.id, { startedAt, finishedAt: new Date().toISOString() });
      }
      state.currentSourceId = undefined;

      // ─── Phase 2: spend the budget, round-robin, newest first. ──────────
      // Runs over the whole backlog, not just this run's inserts, so articles
      // left waiting by an earlier run get their turn.
      state.phase = 'simplifying';
      state.budget = options.budget ?? createSettingsRepository(db).getAppSettings().simplifyBudget;

      const waiting = raws.waitingIdsBySource();
      // Ordered by the run's own source list, so allocation is deterministic
      // and a source this run did not cover cannot take its budget.
      const queues = state.sourceIds
        .map((sourceId) => waiting.find((group) => group.sourceId === sourceId))
        .filter((group): group is SourceQueue => group !== undefined);

      const batch = selectBudgetedBatch(queues, state.budget);
      const report = await simplifyRawArticles(db, batch, {
        client: options.client,
        onProgress: (done) => { state.simplifiedCount = done; },
      });

      // Attribute each article's outcome back to the source it came from.
      for (const row of report.simplified) {
        const result = state.results.find((r) => r.sourceId === row.sourceId);
        if (!result) continue;
        result.simplified.push({
          rawId: row.rawId,
          kidHeadline: row.kidHeadline,
          safety: row.safety,
          engine: row.engine,
        });
        result.costUsd += row.costUsd;
        if (row.fallbackReason) result.fallbacks.push(row.fallbackReason);
      }

      // Counted, not subtracted: phase 2 may have cleared backlog from an
      // earlier run, so this run's `inserted` is not the right basis.
      for (const result of state.results) {
        result.leftWaiting = raws.countWaitingForSource(result.sourceId);
      }

      // Recorded now rather than per source, because the simplification counts
      // are not known until the budget has been spent.
      for (const result of state.results) {
        const timing = timings.get(result.sourceId);
        if (!timing) continue;
        try {
          runs.record(result, { ...timing, trigger: state.trigger });
        } catch (error: unknown) {
          console.error('[scrape] could not record the run:', error);
        }
      }
    } catch (error: unknown) {
      // Without this the run would stay `running: true` forever, which is the
      // bug the old un-caught IIFE had.
      console.error('[scrape] run failed:', error instanceof Error ? error.message : error);
    } finally {
      state.currentSourceId = undefined;
      state.finishedAt = new Date().toISOString();
      state.running = false;
      releaseJob();
      options.onFinished?.(state);
    }
  })();

  return state;
}

/** Totals for the UI. */
export function summarise(state: RunState) {
  return {
    inserted: state.results.reduce((total, r) => total + r.inserted, 0),
    simplified: state.results.reduce((total, r) => total + r.simplified.length, 0),
    leftWaiting: state.results.reduce((total, r) => total + r.leftWaiting, 0),
    failed: state.results.filter((r) => !r.ok).length,
    costUsd: state.results.reduce((total, r) => total + r.costUsd, 0),
  };
}
