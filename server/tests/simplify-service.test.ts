/**
 * On-demand simplification and the one-job-at-a-time rule.
 *
 * The lock is not tidiness: a scrape's simplification phase and a manual batch
 * both write kid_articles for raw rows, so running them together could write
 * two kid articles for one raw article.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGE_BANDS, AGE_BAND_ANCHORS } from '../src/core/article.js';
import { createRawArticleRepository } from '../src/db/repositories/rawArticleRepository.js';
import { OpenRouterClient } from '../src/llm/openRouterClient.js';
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

    // One report row per story, three kid_articles rows: one per reading band.
    expect(report.simplified).toHaveLength(1);
    expect(report.failures).toEqual([]);
    expect(countRows(ctx.db, 'kid_articles')).toBe(3);

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

    expect(countRows(ctx.db, 'kid_articles')).toBe(3);
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);
  });

  it('skips an already-simplified id instead of writing a second kid article', async () => {
    seedWaiting('r1');
    await simplifyRawArticles(ctx.db, ['r1']);

    const again = await simplifyRawArticles(ctx.db, ['r1']);

    expect(again.skipped).toEqual(['r1']);
    expect(again.simplified).toEqual([]);
    // Still three, not six: the claim stops a second set being written.
    expect(countRows(ctx.db, 'kid_articles')).toBe(3);
  });

  it('skips a dismissed id instead of simplifying it', async () => {
    seedWaiting('r1');
    createRawArticleRepository(ctx.db).dismiss(['r1'], '2026-09-09T10:00:00.000Z');

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    expect(report.skipped).toEqual(['r1']);
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
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

  it('creates one version per reading band, stored under the band anchor', async () => {
    seedWaiting('r1');

    await simplifyRawArticles(ctx.db, ['r1']);

    const ages = ctx.db
      .prepare(`SELECT ageTarget FROM kid_articles WHERE originalId = 'r1' ORDER BY ageTarget`)
      .pluck().all();
    expect(ages).toEqual([...AGE_BAND_ANCHORS]);
  });

  it('reports how many versions a story produced', async () => {
    seedWaiting('r1');

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    // One row per STORY, carrying the version count — not one row per band.
    expect(report.simplified).toHaveLength(1);
    expect(report.simplified[0].versions).toBe(AGE_BANDS.length);
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
    // §6: the deny-list judges the source article, so a hit must apply to
    // every band. A story that is skip-young at 5-7 cannot be calm at 11-14.
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

  it('writes every band or none', async () => {
    seedWaiting('r1');
    // A trigger that aborts the 11-14 insert. The versions are written in
    // ascending band order, so this fails on the LAST one — the case that
    // proves the earlier two are rolled back rather than left behind.
    ctx.db.exec(`
      CREATE TRIGGER fail_on_last_band BEFORE INSERT ON kid_articles
      WHEN NEW.ageTarget = 11
      BEGIN SELECT RAISE(ABORT, 'simulated failure on the last version'); END;
    `);

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    expect(report.failures).toHaveLength(1);
    expect(report.simplified).toEqual([]);
    // Nothing partial survived, and the story is still waiting to be retried.
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    expect(createRawArticleRepository(ctx.db).findById('r1')?.simplifiedAt).toBeNull();
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);

    ctx.db.exec('DROP TRIGGER fail_on_last_band');
  });

  it('carries the source id, so a run can attribute the spend', async () => {
    seedWaiting('r1', { sourceId: 'npr', sourceName: 'NPR' });

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    expect(report.simplified[0].sourceId).toBe('npr');
  });

  describe('the spoken script the model wrote', () => {
    const SCRIPT = 'Hello! A robot went down to the reef today. It found the coral is doing well.';

    /** A model that answers every band with the same well-formed version. */
    const modelWriting = (audioScript: string | null) =>
      new OpenRouterClient({
        apiKey: 'test-key',
        maxRetries: 0,
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  kidHeadline: 'A robot went to look at a reef',
                  summary: 'A robot explored a reef under the sea.',
                  whatHappened: 'A robot with lights went down to the reef.',
                  whyItMatters: 'Reefs are home to lots of sea animals.',
                  vocab: [{ word: 'reef', definition: 'A ridge of rock under the sea.' }],
                  thinkAbout: 'What would you look for down there?',
                  audioScript,
                  feelingNote: null,
                  safety: 'calm',
                  contentWarnings: [],
                  readingMinutes: 3,
                }),
              },
            }],
            usage: { total_tokens: 800, cost: 0.00017 },
          }),
        })) as unknown as typeof fetch,
      });

    it('round-trips from the model onto the row and back out of the API', async () => {
      seedWaiting('r1');

      const report = await simplifyRawArticles(ctx.db, ['r1'], { client: modelWriting(SCRIPT) });

      expect(report.simplified[0].engine).toBe('llm');
      // Stored on every band: one call per band, each writing its own script.
      expect(ctx.db.prepare(`SELECT audioScript FROM kid_articles`).pluck().all())
        .toEqual(Array(AGE_BANDS.length).fill(SCRIPT));

      // And read back by the queue an editor reviews from — the whole point of
      // storing it is that a person sees the same words the child hears.
      const { stories } = await (await ctx.api('/api/admin/stories')).json();
      expect(stories[0].versions.map((v: { audioScript: string | null }) => v.audioScript))
        .toEqual(Array(AGE_BANDS.length).fill(SCRIPT));
    });

    it('serves it to the podcast page once the story is published', async () => {
      seedWaiting('r1');
      await simplifyRawArticles(ctx.db, ['r1'], { client: modelWriting(SCRIPT) });
      const id = ctx.db.prepare(`SELECT id FROM kid_articles WHERE ageTarget = 8`).pluck().get() as string;
      await ctx.api(`/api/admin/articles/${id}/publish`, { method: 'PATCH' });

      const published = await (await ctx.anon('/api/articles?age=9')).json();

      expect(published[0].audioScript).toBe(SCRIPT);
    });

    it('stores null when the model omitted it, rather than failing the story', async () => {
      seedWaiting('r1');

      const report = await simplifyRawArticles(ctx.db, ['r1'], { client: modelWriting(null) });

      // §9.1: a missing script is a much smaller loss than a lost story.
      expect(report.simplified[0].engine).toBe('llm');
      expect(ctx.db.prepare(`SELECT DISTINCT audioScript FROM kid_articles`).pluck().all())
        .toEqual([null]);
    });
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
    // Two stories, one version per reading band each.
    expect(countRows(ctx.db, 'kid_articles')).toBe(2 * AGE_BANDS.length);
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
