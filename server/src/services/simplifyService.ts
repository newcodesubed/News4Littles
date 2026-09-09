/**
 * Turning waiting raw articles into kid articles, on purpose rather than by
 * default.
 *
 * PRD §5.2 lists steps 4-7 as one pass, simplifying every item a feed offers.
 * That is 40-50 model calls per run for a queue an editor triages ten of, so
 * ingestion stops at step 5 and this module owns steps 6-7 under a budget
 * (scrape phase 2) or an editor's explicit request (the review queue's
 * "Not yet simplified" tab). Both go through the same function, so the
 * automatic and manual paths cannot drift apart.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../core/errors.js';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { createSettingsRepository } from '../db/repositories/settingsRepository.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import { simplifyArticle } from '../pipeline/simplifyArticle.js';
import { acquireJob, releaseJob } from './jobLock.js';

export interface SimplifiedRow {
  rawId: string;
  /** Carried so a scrape run can attribute the cost back to the right source. */
  sourceId: string;
  kidHeadline: string;
  safety: string;
  engine: string;
  costUsd: number;
  fallbackReason?: string;
}

export interface SimplifyFailure {
  rawId: string;
  error: string;
}

export interface SimplifyReport {
  simplified: SimplifiedRow[];
  failures: SimplifyFailure[];
  /** Ids that were already simplified — a double submit, not an error. */
  skipped: string[];
}

export interface SimplifyOptions {
  /** Test and sandbox seam; without one, simplifyArticle reads LLM_ENABLED. */
  client?: OpenRouterClient;
  now?: () => string;
  /** Called with the number of ids attempted so far, for progress polling. */
  onProgress?: (done: number) => void;
}

/**
 * Simplify exactly these raw articles, one at a time.
 *
 * Each article is its own transaction. simplifyArticle is async and so cannot
 * sit inside a better-sqlite3 transaction anyway, and committing per article
 * makes a batch resumable: a failure on the seventh keeps the first six and
 * leaves the rest waiting for another attempt.
 *
 * Does NOT take the job lock — callers own that, because a scrape run holds it
 * across both of its phases.
 */
export async function simplifyRawArticles(
  db: Database,
  rawIds: string[],
  options: SimplifyOptions = {},
): Promise<SimplifyReport> {
  const raws = createRawArticleRepository(db);
  const articles = createArticleRepository(db);
  const { defaultAge } = createSettingsRepository(db).getAppSettings();
  const clock = options.now ?? (() => new Date().toISOString());

  const report: SimplifyReport = { simplified: [], failures: [], skipped: [] };
  let done = 0;

  for (const rawId of rawIds) {
    try {
      const raw = raws.findById(rawId);
      if (!raw) {
        report.failures.push({ rawId, error: `Raw article '${rawId}' no longer exists.` });
        continue;
      }
      if (raw.simplifiedAt !== null) {
        report.skipped.push(rawId);
        continue;
      }

      const now = clock();
      // simplifyArticle never throws: it falls back to the rule-based pipeline
      // (§9.2) and flags why, so there is no "unsimplifiable" article here.
      const outcome = await simplifyArticle(
        db,
        {
          id: raw.id,
          headline: raw.headline,
          body: raw.body,
          topic: raw.topic,
          sourceName: raw.sourceName,
          sourceUrl: raw.sourceUrl,
        },
        { ageTarget: defaultAge, now, client: options.client },
      );

      const claimed = db.transaction(() => {
        // The claim and the insert commit together: if another writer got here
        // first, markSimplified reports false and no second kid article exists.
        if (!raws.markSimplified(raw.id, now)) return false;
        articles.insert({
          ...outcome.article,
          originalId: raw.id,
          // §5.2 step 7: never auto-publish, whatever the guard decided.
          status: 'pending_review',
          publishedAt: null,
        });
        return true;
      })();

      if (!claimed) {
        report.skipped.push(rawId);
        continue;
      }

      report.simplified.push({
        rawId: raw.id,
        sourceId: raw.sourceId,
        kidHeadline: outcome.article.kidHeadline,
        safety: outcome.article.safety,
        engine: outcome.engine,
        costUsd: outcome.costUsd ?? 0,
        fallbackReason: outcome.fallbackReason,
      });
    } catch (error: unknown) {
      // A database failure on one article leaves simplifiedAt NULL, so the row
      // stays waiting and can be retried. The batch carries on.
      report.failures.push({
        rawId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      done += 1;
      options.onProgress?.(done);
    }
  }

  return report;
}

export interface SimplifyJobState {
  id: string;
  startedAt: string;
  finishedAt?: string;
  rawIds: string[];
  /** How many of rawIds have been attempted, for the progress line. */
  done: number;
  running: boolean;
  report: SimplifyReport;
}

/** Module-level for the same reason as the job lock: one process, one admin. */
let current: SimplifyJobState | null = null;

export function getSimplifyJob(): SimplifyJobState | null {
  return current;
}

/** Test seam: forget any job and let go of the lock. */
export function resetSimplifyJob(): void {
  current = null;
  releaseJob();
}

/**
 * Begin a manual batch and return immediately; the client polls for progress.
 * Fifteen articles is a minute or more of sequential model calls, which is too
 * long to hold an HTTP request open — the same reason scraping works this way.
 */
export function startSimplifyJob(
  db: Database,
  rawIds: string[],
  options: SimplifyOptions & { onFinished?: (state: SimplifyJobState) => void } = {},
): SimplifyJobState {
  if (rawIds.length === 0) throw new BadRequestError('No articles were selected.');

  acquireJob('simplify');

  const state: SimplifyJobState = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    rawIds,
    done: 0,
    running: true,
    report: { simplified: [], failures: [], skipped: [] },
  };
  current = state;

  // Deliberately not awaited: the caller gets the state back straight away.
  void (async () => {
    try {
      state.report = await simplifyRawArticles(db, rawIds, {
        ...options,
        onProgress: (done) => { state.done = done; },
      });
    } catch (error: unknown) {
      state.report.failures.push({
        rawId: '(batch)',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Always: a leaked lock would block every later scrape and batch.
      state.running = false;
      state.finishedAt = new Date().toISOString();
      releaseJob();
      options.onFinished?.(state);
    }
  })();

  return state;
}
