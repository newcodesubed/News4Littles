/**
 * On-demand simplification and the one-job-at-a-time rule.
 *
 * The lock is not tidiness: a scrape's simplification phase and a manual batch
 * both write kid_articles for raw rows, so running them together could write
 * two kid articles for one raw article.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRawArticleRepository } from '../src/db/repositories/rawArticleRepository.js';
import { acquireJob, activeJob, releaseJob } from '../src/services/jobLock.js';
import {
  getSimplifyJob, resetSimplifyJob, simplifyRawArticles, startSimplifyJob,
  type SimplifyJobState,
} from '../src/services/simplifyService.js';
import {
  countRows, createTestContext, insertRawArticle, type TestContext,
} from './helpers.js';

describe('jobLock', () => {
  beforeEach(() => releaseJob());

  it('is free to begin with', () => {
    expect(activeJob()).toBeNull();
  });

  it('refuses a second job while one is held, naming the holder', () => {
    acquireJob('scrape');
    expect(activeJob()).toBe('scrape');
    expect(() => acquireJob('simplify')).toThrow(/scrape is already running/);
  });

  it('refuses a scrape while a simplification batch is running', () => {
    acquireJob('simplify');
    expect(() => acquireJob('scrape')).toThrow(/simplification batch is already running/);
  });

  it('can be taken again after release', () => {
    acquireJob('simplify');
    releaseJob();
    expect(activeJob()).toBeNull();
    expect(() => acquireJob('scrape')).not.toThrow();
  });
});

describe('simplifyRawArticles', () => {
  let ctx: TestContext;

  /** A waiting raw article: one a scrape stored but did not simplify. */
  const seedWaiting = (id: string, over: Record<string, unknown> = {}) =>
    insertRawArticle(ctx.db, {
      id,
      headline: `Adult headline ${id}`,
      body: 'A rover surveyed the reef and found the coral healthy this year.',
      url: `https://example.com/${id}`,
      simplifiedAt: null,
      ...over,
    });

  beforeEach(() => { ctx = createTestContext(); resetSimplifyJob(); });
  afterEach(() => { ctx.close(); resetSimplifyJob(); });

  it('creates a pending_review kid article and stamps the raw as simplified', async () => {
    seedWaiting('r1');

    const report = await simplifyRawArticles(ctx.db, ['r1'], { now: () => '2026-09-09T10:00:00.000Z' });

    expect(report.simplified).toHaveLength(1);
    expect(report.failures).toEqual([]);
    expect(countRows(ctx.db, 'kid_articles')).toBe(1);

    const article = ctx.db
      .prepare(`SELECT status, publishedAt, originalId FROM kid_articles`)
      .get() as { status: string; publishedAt: string | null; originalId: string };
    // §5.2 step 7 / §2.2: nothing this feature touches may auto-publish.
    expect(article.status).toBe('pending_review');
    expect(article.publishedAt).toBeNull();
    expect(article.originalId).toBe('r1');

    const repo = createRawArticleRepository(ctx.db);
    expect(repo.findById('r1')?.simplifiedAt).toBe('2026-09-09T10:00:00.000Z');
    expect(repo.countWaiting()).toBe(0);
  });

  it('leaves the backlog alone for ids it was not given', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    await simplifyRawArticles(ctx.db, ['r1']);

    expect(countRows(ctx.db, 'kid_articles')).toBe(1);
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);
  });

  it('skips an already-simplified id instead of writing a second kid article', async () => {
    seedWaiting('r1');
    await simplifyRawArticles(ctx.db, ['r1']);

    const again = await simplifyRawArticles(ctx.db, ['r1']);

    expect(again.skipped).toEqual(['r1']);
    expect(again.simplified).toEqual([]);
    expect(countRows(ctx.db, 'kid_articles')).toBe(1);
  });

  it('reports an unknown id as a failure without stopping the batch', async () => {
    seedWaiting('r1');

    const report = await simplifyRawArticles(ctx.db, ['nope', 'r1']);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].rawId).toBe('nope');
    // The good one still went through: the batch is resumable, not all-or-nothing.
    expect(report.simplified.map((row) => row.rawId)).toEqual(['r1']);
  });

  it('reports progress as it goes, so a poller can show a count', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    const seen: number[] = [];
    await simplifyRawArticles(ctx.db, ['r1', 'r2'], { onProgress: (done) => seen.push(done) });

    expect(seen).toEqual([1, 2]);
  });

  it('carries the source id, so a run can attribute the spend', async () => {
    seedWaiting('r1', { sourceId: 'npr', sourceName: 'NPR' });

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    expect(report.simplified[0].sourceId).toBe('npr');
  });
});

describe('startSimplifyJob', () => {
  let ctx: TestContext;

  const seedWaiting = (id: string) =>
    insertRawArticle(ctx.db, {
      id,
      headline: `Adult headline ${id}`,
      body: 'A rover surveyed the reef and found the coral healthy this year.',
      url: `https://example.com/${id}`,
      simplifiedAt: null,
    });

  beforeEach(() => { ctx = createTestContext(); resetSimplifyJob(); });
  afterEach(() => { ctx.close(); resetSimplifyJob(); });

  it('returns immediately and finishes in the background', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    const state = await new Promise<SimplifyJobState>((resolve) => {
      const started = startSimplifyJob(ctx.db, ['r1', 'r2'], { onFinished: resolve });
      expect(started.running).toBe(true);
      expect(started.rawIds).toEqual(['r1', 'r2']);
      expect(getSimplifyJob()?.id).toBe(started.id);
    });

    expect(state.running).toBe(false);
    expect(state.finishedAt).toBeTruthy();
    expect(state.done).toBe(2);
    expect(state.report.simplified).toHaveLength(2);
    expect(countRows(ctx.db, 'kid_articles')).toBe(2);
  });

  it('holds the lock while running and releases it at the end', async () => {
    seedWaiting('r1');

    await new Promise<SimplifyJobState>((resolve) => {
      startSimplifyJob(ctx.db, ['r1'], { onFinished: resolve });
      expect(activeJob()).toBe('simplify');
      expect(() => startSimplifyJob(ctx.db, ['r1'])).toThrow(/already running/);
    });

    expect(activeJob()).toBeNull();
  });

  it('rejects an empty selection', () => {
    expect(() => startSimplifyJob(ctx.db, [])).toThrow(/no articles/i);
    // A rejected start must not leave the lock held.
    expect(activeJob()).toBeNull();
  });
});
