/**
 * Auto mode (AUTO_APPROVE_ENABLED): publish the stories the judge approves,
 * leave everything else exactly where it was.
 *
 * §2.2 promises a human reads every story before a child does. This is the one
 * path that breaks that promise, so it is written to fail closed:
 *
 *  - a story is published ONLY on an explicit `approved === true`
 *  - a skip-young story is never published and never even judged (§6, §4.2 —
 *    the content most likely to upset a child stays human-only)
 *  - an already-published story is left alone, so a human's decision is never
 *    relabelled as the judge's
 *  - every publish records `approvedBy = 'auto'`, so a story no person read is
 *    always identifiable afterwards
 *
 * There is no error handling for the failure cases because there is nothing to
 * handle: judgeStory never throws and never returns approved:true by accident,
 * and everything here hangs off that one boolean.
 */
import type { Database } from 'better-sqlite3';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import { AUTO_APPROVE_ENABLED } from '../env.js';
import { OpenRouterClient } from '../llm/openRouterClient.js';
import { logger } from '../logger.js';
import { judgeStory } from '../pipeline/approvalGuard.js';

const log = logger.child({ area: 'auto' });

export interface AutoApproveReport {
  /** Stories the judge approved and this published. */
  published: { originalId: string; reason: string }[];
  /** Stories left in pending_review, with why. */
  held: { originalId: string; reason: string }[];
  costUsd: number;
}

/** One story the simplifier just finished, as the caller already knows it. */
export interface AutoApproveCandidate {
  originalId: string;
}

export interface AutoApproveOptions {
  /**
   * REQUIRED, deliberately. This was optional once, and because the caller's
   * own `client` is a test-and-sandbox seam that is undefined in production,
   * auto mode silently held every story with "no LLM client available" instead
   * of judging any. Making it required moves that from a runtime surprise to a
   * compile error, and keeps the service free of a default that would make
   * paid calls from a unit test.
   */
  client: OpenRouterClient;
  now?: () => string;
}

export async function autoApproveStories(
  db: Database,
  candidates: AutoApproveCandidate[],
  options: AutoApproveOptions,
): Promise<AutoApproveReport> {
  const articles = createArticleRepository(db);
  const clock = options.now ?? (() => new Date().toISOString());
  const report: AutoApproveReport = { published: [], held: [], costUsd: 0 };

  for (const candidate of candidates) {
    const { originalId } = candidate;
    // findStory gives the strictest safety across versions and the versions
    // themselves, which is what the gates below need.
    const story = articles.findStory(originalId);
    if (!story) continue;

    if (story.status !== 'pending_review') {
      // A person already decided. Never overwrite that, and never spend a call.
      report.held.push({ originalId, reason: `already ${story.status}` });
      continue;
    }

    if (story.safety === 'skip-young') {
      // Not judged at all: §6 makes these an explicit human decision, so there
      // is no verdict here for the judge to get wrong.
      report.held.push({ originalId, reason: 'held: skip-young needs a person (§6)' });
      continue;
    }

    // The youngest band's version: the strictest reading level and the most
    // sensitive reader. Publishing is story-scoped, so one verdict covers all.
    const youngest = story.versions[0];
    const verdict = await judgeStory(options.client, youngest);
    report.costUsd += verdict.costUsd ?? 0;

    if (!verdict.approved) {
      report.held.push({ originalId, reason: verdict.reason });
      continue;
    }

    articles.publishStory(youngest.id, clock(), 'auto');
    report.published.push({ originalId, reason: verdict.reason });
  }

  return report;
}

/**
 * Auto mode for stories just simplified, wherever that happened: a scrape run,
 * or an editor pressing "Simplify" on the waiting backlog. It used to run only
 * inside a scrape, so a story simplified from the backlog was never judged and
 * waited for a person even when auto mode was on.
 *
 * Returns null, judging nothing, unless auto mode is on. Logs every decision.
 */
export async function autoApproveIfEnabled(
  db: Database,
  originalIds: string[],
  options: {
    /** Overrides AUTO_APPROVE_ENABLED. A test seam. */
    enabled?: boolean;
    /** The callers' own test seam; undefined in production, so a default is built here. */
    client?: OpenRouterClient;
  } = {},
): Promise<AutoApproveReport | null> {
  // AUTO_APPROVE_ENABLED already implies LLM_ENABLED, so a key exists here.
  if (!(options.enabled ?? AUTO_APPROVE_ENABLED) || originalIds.length === 0) return null;

  const report = await autoApproveStories(
    db,
    originalIds.map((originalId) => ({ originalId })),
    { client: options.client ?? new OpenRouterClient({}) },
  );

  for (const held of report.held) {
    log.info({ originalId: held.originalId, reason: held.reason }, 'held for review');
  }
  for (const done of report.published) {
    log.info({ originalId: done.originalId, reason: done.reason }, 'published with no editor');
  }
  return report;
}
