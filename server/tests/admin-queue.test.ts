/** Review-queue reads: filters, sorting, counts — PRD §4.2. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, insertKidArticle, insertRawArticle, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = createTestContext();
  const manualRaw = insertRawArticle(ctx.db, {
    sourceId: 'manual', sourceName: 'Manual submission', headline: 'A hand typed original headline',
    // It gets a kid article below, so it is simplified and not backlog.
    simplifiedAt: '2026-09-04T09:00:00.000Z',
  });

  insertKidArticle(ctx.db, { id: 'a-pending', status: 'pending_review', category: 'World', safety: 'calm', ageTarget: 6, readingMinutes: 2, createdAt: '2026-09-01T10:00:00.000Z' });
  insertKidArticle(ctx.db, { id: 'a-published', status: 'published', category: 'Science', safety: 'calm', ageTarget: 8, readingMinutes: 5, createdAt: '2026-09-02T10:00:00.000Z' });
  insertKidArticle(ctx.db, { id: 'a-rejected', status: 'rejected', category: 'Sports', safety: 'calm', ageTarget: 10, readingMinutes: 3, createdAt: '2026-09-03T10:00:00.000Z' });
  insertKidArticle(ctx.db, { id: 'a-adult', status: 'pending_review', category: 'World', safety: 'adult-nearby', ageTarget: 12, readingMinutes: 4, createdAt: '2026-09-04T10:00:00.000Z' });
  insertKidArticle(ctx.db, { id: 'a-skip', status: 'pending_review', category: 'World', safety: 'skip-young', ageTarget: 13, readingMinutes: 6, createdAt: '2026-09-05T10:00:00.000Z' });
  insertKidArticle(ctx.db, { id: 'a-manual', originalId: manualRaw, status: 'pending_review', kidHeadline: 'A coral garden was found', category: 'Environment', safety: 'calm', ageTarget: 7, readingMinutes: 3, createdAt: '2026-09-06T10:00:00.000Z' });
});
afterAll(() => ctx.close());

const list = async (qs = '') => (await (await ctx.api(`/api/admin/articles${qs}`)).json()).articles as any[];
const ids = async (qs = '') => (await list(qs)).map((a) => a.id).sort();

describe('counts (§4.2 tab badges)', () => {
  it('reports one number per status', async () => {
    const counts = await (await ctx.api('/api/admin/articles/counts')).json();
    expect(counts).toMatchObject({ pending_review: 4, published: 1, rejected: 1, total: 6 });
  });

  it('counts what is waiting to be simplified alongside the status tabs', async () => {
    insertRawArticle(ctx.db, { id: 'waiting-1', headline: 'Stored but never simplified' });

    const counts = await (await ctx.api('/api/admin/articles/counts')).json();
    expect(counts.waiting).toBe(1);
    // The status counts must be untouched by the addition.
    expect(counts).toMatchObject({ pending_review: 4, published: 1, rejected: 1, total: 6 });
  });
});

describe('filter options', () => {
  it('lists categories, sources and ages for the dropdowns', async () => {
    const filters = await (await ctx.api('/api/admin/articles/filters')).json();
    expect(filters.categories).toContain('World');
    expect(filters.sources.map((s: any) => s.id)).toContain('manual');
    expect(filters.ageTargets).toContain(6);
  });
});

describe('filters (§4.2)', () => {
  it('status tab', async () => expect(await ids('?status=published')).toEqual(['a-published']));

  it('category multi-select, repeated params', async () =>
    expect(await ids('?category=Science&category=Sports')).toEqual(['a-published', 'a-rejected']));

  it('category multi-select, comma separated', async () =>
    expect(await ids('?category=Science,Sports')).toEqual(['a-published', 'a-rejected']));

  it('"flagged only" selects both non-calm levels in one param', async () =>
    expect(await ids('?flagged=true')).toEqual(['a-adult', 'a-skip']));

  it('explicit safety filter', async () =>
    expect(await ids('?safety=skip-young')).toEqual(['a-skip']));

  it('flagged=true overrides an explicit safety choice', async () =>
    expect(await ids('?flagged=true&safety=calm')).toEqual(['a-adult', 'a-skip']));

  it('source filter matches sources.id, including manual', async () =>
    expect(await ids('?source=manual')).toEqual(['a-manual']));

  it('age target filter', async () => expect(await ids('?ageTarget=6')).toEqual(['a-pending']));

  it('free text over the kid headline', async () =>
    expect(await ids('?q=coral')).toEqual(['a-manual']));

  it('free text also covers the ORIGINAL headline', async () =>
    expect(await ids('?q=hand%20typed')).toEqual(['a-manual']));

  it('treats LIKE wildcards literally', async () =>
    expect(await ids('?q=%25')).toEqual([]));

  it('date range on createdAt', async () =>
    expect(await ids('?createdFrom=2026-09-05')).toEqual(['a-manual', 'a-skip']));

  it('filters combine', async () =>
    expect(await ids('?status=pending_review&category=World&safety=calm')).toEqual(['a-pending']));

  it.each([
    ['status', '?status=bogus'],
    ['safety', '?safety=bogus'],
    ['sort field', '?sort=DROP+TABLE'],
    ['ageTarget', '?ageTarget=abc'],
  ])('rejects a bad %s with 400', async (_l, qs) =>
    expect((await ctx.api(`/api/admin/articles${qs}`)).status).toBe(400));
});

describe('sorting (§4.2)', () => {
  it.each(['createdAt', 'publishedAt', 'readingMinutes', 'ageTarget'])(
    'sorts ascending by %s', async (fieldName) => {
      const values = (await list(`?sort=${fieldName}&order=asc`))
        .map((a) => a[fieldName]).filter((v) => v !== null);
      expect(values).toEqual([...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    });

  it('defaults to newest first', async () => {
    const dates = (await list()).map((a) => a.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe('admin rows carry the extras the queue needs', () => {
  it('includes sourceId and the original headline', async () => {
    const [article] = await list('?source=manual');
    expect(article.sourceId).toBe('manual');
    expect(article.originalHeadline).toBe('A hand typed original headline');
  });
});

describe('story-level reads (§5)', () => {
  it('returns one row per story with every version nested', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'story-raw', headline: 'Adult headline', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    for (const age of [5, 6, 7]) {
      insertKidArticle(ctx.db, {
        id: `v-${age}`, originalId: raw, ageTarget: age, status: 'pending_review',
        kidHeadline: `Version for ${age}`, createdAt: '2026-09-06T10:00:00.000Z',
      });
    }

    const body = await (await ctx.api('/api/admin/stories?status=pending_review')).json();
    const story = body.stories.find((s: any) => s.originalId === raw);

    expect(story.versions).toHaveLength(3);
    expect(story.versions.map((v: any) => v.ageTarget)).toEqual([5, 6, 7]);
    // Labelled by the youngest version.
    expect(story.kidHeadline).toBe('Version for 5');
    expect(story.originalHeadline).toBe('Adult headline');
  });

  it('reports the strictest safety across a story’s versions', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'mixed-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, { id: 'mixed-5', originalId: raw, ageTarget: 5, safety: 'skip-young' });
    insertKidArticle(ctx.db, { id: 'mixed-14', originalId: raw, ageTarget: 14, safety: 'calm' });

    const body = await (await ctx.api('/api/admin/stories?status=pending_review')).json();
    const story = body.stories.find((s: any) => s.originalId === raw);

    // §6: the strictest wins. Showing 'calm' here would hide a skip-young
    // version from the editor about to approve the whole story.
    expect(story.safety).toBe('skip-young');
  });

  it('returns a whole story when any one version matches the filter', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'agefilter-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, { id: 'af-5', originalId: raw, ageTarget: 5 });
    insertKidArticle(ctx.db, { id: 'af-14', originalId: raw, ageTarget: 14 });

    const body = await (await ctx.api('/api/admin/stories?ageTarget=14')).json();
    const story = body.stories.find((s: any) => s.originalId === raw);

    // Filtered on age 14, but both versions come back: the editor reviews the
    // whole story, not the one version that matched.
    expect(story.versions.map((v: any) => v.ageTarget)).toEqual([5, 14]);
  });

  it('counts stories, not versions', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'counted-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    for (const age of [5, 6, 7, 8]) {
      insertKidArticle(ctx.db, { id: `c-${age}`, originalId: raw, ageTarget: age, status: 'rejected' });
    }

    const counts = await (await ctx.api('/api/admin/articles/counts')).json();

    // Asserted as a relationship rather than a literal: this file uses
    // beforeAll, so row counts depend on test order, and a literal here would
    // break every time a test is added above it.
    const versionRows = ctx.db
      .prepare(`SELECT COUNT(*) c FROM kid_articles WHERE status = 'rejected'`).pluck().get();
    const storyRows = ctx.db
      .prepare(`SELECT COUNT(DISTINCT originalId) c FROM kid_articles WHERE status = 'rejected'`)
      .pluck().get();

    // The fixture above makes these differ, which is what makes the test mean
    // something: four versions, one story.
    expect(versionRows).toBeGreaterThan(storyRows as number);
    expect(counts.rejected).toBe(storyRows);
  });

  it('needs admin auth', async () => {
    expect((await ctx.anon('/api/admin/stories')).status).toBe(401);
  });
});
