/**
 * Story-scoped regeneration — §4.2 "Regenerate", under §5's story scope.
 *
 * Re-runs the pipeline over the ORIGINAL raw article for every age version a
 * story has, holds the result in memory, and writes only the ages an editor
 * ticks. Preview and apply are separate because §2.2 promises a person reads
 * what a child will: nothing here writes a row the editor has not seen.
 *
 * Job-shaped for the same reason the manual simplify batch is: ten versions is
 * ten sequential model calls, which is minutes — far too long to hold an HTTP
 * request open. The client polls instead.
 *
 * Apply reuses the HELD preview rather than re-running the pipeline. Re-running
 * would bill a second set of calls and, the model being non-deterministic,
 * could write text the editor never saw in the diff.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { BadRequestError, ConflictError, NotFoundError } from '../core/errors.js';
import {
  createArticleRepository, type AdminArticle, type AdminStory,
} from '../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import { simplifyArticleForAllAges } from '../pipeline/simplifyArticle.js';
import { acquireJob, releaseJob } from './jobLock.js';

export interface RegeneratedVersion {
  ageTarget: number;
  /** The stored row this age would replace. */
  current: AdminArticle;
  generated: AdminArticle;
  engine: string;
  model?: string;
  /** Set when THIS age fell back to the rule-based pipeline (§9.2). */
  fallbackReason?: string;
}

export interface RegenerateJobState {
  id: string;
  originalId: string;
  /** The youngest version's headline, as the progress line's label. */
  kidHeadline: string;
  startedAt: string;
  finishedAt?: string;
  /** The story's existing versions, ascending. Never ALL_AGES by assumption. */
  ages: number[];
  /** Ages attempted so far, for "Regenerating… 4/10". */
  done: number;
  running: boolean;
  versions: RegeneratedVersion[];
  /** Spent whether or not the editor applies. */
  costUsd: number;
  /** A thrown failure. A single weak age is a fallbackReason, not this. */
  error?: string;
  /** Set once applied, so the client stops offering apply. */
  appliedAges?: number[];
}

export interface RegenerateOptions {
  /** Test and sandbox seam; without one, simplifyArticle reads LLM_ENABLED. */
  client?: OpenRouterClient;
  now?: () => string;
}

/** Module-level for the same reason as the job lock: one process, one admin. */
let current: RegenerateJobState | null = null;

export function getRegenerateJob(): RegenerateJobState | null {
  return current;
}

/** Test seam, and the Discard button: forget the preview, let go of the lock. */
export function resetRegenerateJob(): void {
  current = null;
  releaseJob();
}

/**
 * Begin a preview for the story `id` belongs to and return immediately.
 *
 * `id` may be ANY version's id, as it may for publish and reject (§5): an
 * editor acts on a story, and the queue happens to hold ten rows for it.
 */
export function startRegenerateJob(
  db: Database,
  id: string,
  options: RegenerateOptions & { onFinished?: (state: RegenerateJobState) => void } = {},
): RegenerateJobState {
  const articles = createArticleRepository(db);
  const rawArticles = createRawArticleRepository(db);
  const clock = options.now ?? (() => new Date().toISOString());

  const state = articles.findStoryState(id);
  if (!state) throw NotFoundError.of('article', id);

  // Checked before findStory: findStory's ADMIN_SELECT inner-joins raw_articles,
  // so a story whose raw article is gone would otherwise surface as "No
  // article", masking the real, more useful cause.
  const raw = rawArticles.findById(state.originalId);
  if (!raw) throw NotFoundError.of('raw article', state.originalId);

  const story = articles.findStory(state.originalId);
  if (!story) throw NotFoundError.of('article', id);

  // After every 404, so a bad request cannot take the lock and block a scrape.
  acquireJob('regenerate');

  const byAge = new Map(story.versions.map((version) => [version.ageTarget, version]));
  const job: RegenerateJobState = {
    id: randomUUID(),
    originalId: story.originalId,
    kidHeadline: story.kidHeadline,
    startedAt: clock(),
    ages: story.versions.map((version) => version.ageTarget),
    done: 0,
    running: true,
    versions: [],
    costUsd: 0,
  };
  current = job;

  // Deliberately not awaited: the caller gets the state back straight away.
  void (async () => {
    try {
      const outcome = await simplifyArticleForAllAges(
        db,
        {
          id: raw.id,
          headline: raw.headline,
          body: raw.body,
          topic: raw.topic,
          sourceName: raw.sourceName,
          // The article, not the feed it came from — see simplifyService.
          sourceUrl: raw.url,
        },
        {
          client: options.client,
          ages: job.ages,
          // Each age is built as the row it will replace, so the diff and the
          // update both address the version the editor is looking at.
          perAge: (age) => {
            const stored = byAge.get(age);
            return stored ? { id: stored.id, now: stored.createdAt } : undefined;
          },
          onProgress: (done) => { job.done = done; },
        },
      );

      job.costUsd = outcome.costUsd;
      job.versions = outcome.versions.map((version) => {
        // Non-null: perAge built this age from exactly this map.
        const stored = byAge.get(version.article.ageTarget)!;
        return {
          ageTarget: stored.ageTarget,
          current: stored,
          engine: version.engine,
          model: version.model,
          fallbackReason: version.fallbackReason,
          // Identity and lifecycle fields are carried over, so the diff shows
          // only what regeneration would actually change.
          generated: {
            ...version.article,
            status: stored.status,
            publishedAt: stored.publishedAt,
            rejectReason: stored.rejectReason,
            editedByHuman: false,
            sourceId: stored.sourceId,
            originalHeadline: stored.originalHeadline,
            // Regenerating text does not change who approved the story.
            approvedBy: stored.approvedBy,
          },
        };
      });
    } catch (error: unknown) {
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      // Always: a leaked lock would block every later scrape and batch.
      job.running = false;
      job.finishedAt = clock();
      releaseJob();
      options.onFinished?.(job);
    }
  })();

  return job;
}

/**
 * Write the ticked ages from the held preview.
 *
 * One transaction for every age: a story left holding a mix of chosen and
 * unchosen rewrites is not something an editor could reason about.
 */
export function applyRegeneratedVersions(
  db: Database,
  jobId: string,
  ages: number[],
): AdminStory {
  const job = current;
  if (!job || job.id !== jobId) {
    throw new ConflictError('That preview is no longer the current one. Regenerate the story again.');
  }
  if (job.running) {
    throw new ConflictError('That regeneration is still running. Wait for it to finish.');
  }
  if (ages.length === 0) {
    throw new BadRequestError('No versions were ticked, so there is nothing to apply.');
  }

  const byAge = new Map(job.versions.map((version) => [version.ageTarget, version]));
  const chosen = ages.map((age) => {
    const version = byAge.get(age);
    if (!version) throw new BadRequestError(`This preview does not include age ${age}.`);
    return version;
  });

  const articles = createArticleRepository(db);
  db.transaction(() => {
    for (const version of chosen) {
      articles.applyRegeneration(version.generated.id, version.generated);
    }
  })();

  job.appliedAges = [...ages];

  // A story deleted while the dialog was open updates nothing, so saying so
  // afterwards costs nothing and tells the editor the truth.
  const story = articles.findStory(job.originalId);
  if (!story) throw NotFoundError.of('article', job.originalId);
  return story;
}
