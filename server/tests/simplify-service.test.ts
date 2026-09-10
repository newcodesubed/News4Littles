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

  it('refuses a simplification batch while a regeneration is running', () => {
    acquireJob('regenerate');
    expect(() => acquireJob('simplify')).toThrow(/regeneration is already running/);
  });

  it('refuses a regeneration while a scrape is running', () => {
    acquireJob('scrape');
    expect(() => acquireJob('regenerate')).toThrow(/scrape is already running/);
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

    // One report row per story, ten kid_articles rows: one per reading age.
    expect(report.simplified).toHaveLength(1);
    expect(report.failures).toEqual([]);
    expect(countRows(ctx.db, 'kid_articles')).toBe(10);

    const article = ctx.db
      .prepare(`SELECT status, publishedAt, originalId FROM kid_articles LIMIT 1`)
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

    expect(countRows(ctx.db, 'kid_articles')).toBe(10);
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);
  });

  it('skips an already-simplified id instead of writing a second kid article', async () => {
    seedWaiting('r1');
    await simplifyRawArticles(ctx.db, ['r1']);

    const again = await simplifyRawArticles(ctx.db, ['r1']);

    expect(again.skipped).toEqual(['r1']);
    expect(again.simplified).toEqual([]);
    // Still ten, not twenty: the claim stops a second set being written.
    expect(countRows(ctx.db, 'kid_articles')).toBe(10);
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

  it('links the kid article to the article, not to the feed', async () => {
    // raw.url is the story; raw.sourceUrl is the rss.xml the story came from.
    // kid_articles.sourceUrl is the "Read the original (for grown-ups)" link,
    // so a grown-up following it must land on the article, not on raw XML.
    seedWaiting('r1', {
      url: 'https://www.bbc.co.uk/news/articles/the-actual-story',
      sourceUrl: 'https://feeds.bbci.co.uk/news/rss.xml',
    });

    await simplifyRawArticles(ctx.db, ['r1']);

    const link = ctx.db.prepare(`SELECT sourceUrl FROM kid_articles`).pluck().get();
    expect(link).toBe('https://www.bbc.co.uk/news/articles/the-actual-story');
    expect(link).not.toMatch(/rss\.xml$/);
  });

  it('creates one version per reading age', async () => {
    seedWaiting('r1');

    await simplifyRawArticles(ctx.db, ['r1']);

    const ages = ctx.db
      .prepare(`SELECT ageTarget FROM kid_articles WHERE originalId = 'r1' ORDER BY ageTarget`)
      .pluck().all();
    expect(ages).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('reports how many versions a story produced', async () => {
    seedWaiting('r1');

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    // One row per STORY, carrying the version count — not ten rows.
    expect(report.simplified).toHaveLength(1);
    expect(report.simplified[0].versions).toBe(10);
  });

  it('never auto-publishes any version', async () => {
    seedWaiting('r1');

    await simplifyRawArticles(ctx.db, ['r1']);

    const statuses = ctx.db.prepare(`SELECT DISTINCT status FROM kid_articles`).pluck().all();
    expect(statuses).toEqual(['pending_review']);
    expect(
      ctx.db.prepare(`SELECT COUNT(*) c FROM kid_articles WHERE publishedAt IS NOT NULL`).get(),
    ).toEqual({ c: 0 });
  });

  it('raises every version when the deny-list fires', async () => {
    // §6: the deny-list judges the source article, so a hit must apply to all
    // ten ages. A story that is skip-young at 5 cannot be calm at 14.
    seedWaiting('r1', {
      headline: 'A disaster and an earthquake struck',
      body: 'A disaster struck. An earthquake killed people. There was violence.',
    });

    await simplifyRawArticles(ctx.db, ['r1']);

    const safeties = ctx.db.prepare(`SELECT DISTINCT safety FROM kid_articles`).pluck().all();
    expect(safeties).toEqual(['skip-young']);
  });

  it('gives every version the same original article link', async () => {
    seedWaiting('r1', { url: 'https://www.bbc.co.uk/news/articles/the-story' });

    await simplifyRawArticles(ctx.db, ['r1']);

    const links = ctx.db.prepare(`SELECT DISTINCT sourceUrl FROM kid_articles`).pluck().all();
    expect(links).toEqual(['https://www.bbc.co.uk/news/articles/the-story']);
  });

  it('writes all ten versions or none', async () => {
    seedWaiting('r1');
    // A trigger that aborts the age-14 insert. The versions are written in
    // ascending age order, so this fails on the LAST one — the case that proves
    // the earlier nine are rolled back rather than left behind.
    ctx.db.exec(`
      CREATE TRIGGER fail_on_age_14 BEFORE INSERT ON kid_articles
      WHEN NEW.ageTarget = 14
      BEGIN SELECT RAISE(ABORT, 'simulated failure on the last version'); END;
    `);

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    expect(report.failures).toHaveLength(1);
    expect(report.simplified).toEqual([]);
    // Nothing partial survived, and the story is still waiting to be retried.
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    expect(createRawArticleRepository(ctx.db).findById('r1')?.simplifiedAt).toBeNull();
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);

    ctx.db.exec('DROP TRIGGER fail_on_age_14');
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
    // Two stories, ten reading ages each.
    expect(countRows(ctx.db, 'kid_articles')).toBe(20);
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
