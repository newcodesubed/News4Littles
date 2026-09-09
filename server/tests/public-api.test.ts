/** Public article routes — PRD §3, §11.1. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext, insertKidArticle, insertRawArticle, type TestContext,
} from './helpers.js';

let ctx: TestContext;

/**
 * The shared fixtures below are all at ageTarget 8 (the helper's default),
 * while app_settings.defaultAge is 6. Age is now an exact filter, so a read
 * that wants these stories has to ask for age 8.
 */
const AT_8 = '?age=8';

beforeAll(() => {
  ctx = createTestContext();
  insertKidArticle(ctx.db, { id: 'pub-1', status: 'published', createdAt: '2026-09-03T10:00:00.000Z' });
  insertKidArticle(ctx.db, { id: 'pub-2', status: 'published', createdAt: '2026-09-04T10:00:00.000Z' });
  insertKidArticle(ctx.db, { id: 'pending-1', status: 'pending_review' });
  insertKidArticle(ctx.db, { id: 'rejected-1', status: 'rejected', rejectReason: 'Too grim' });
  insertKidArticle(ctx.db, { id: 'flagged-1', status: 'published', safety: 'adult-nearby', contentWarnings: ['storm'] });
});
afterAll(() => ctx.close());

describe('GET /api/articles', () => {
  it('returns a bare array', async () => {
    expect(Array.isArray(await (await ctx.anon(`/api/articles${AT_8}`)).json())).toBe(true);
  });

  it('sorts newest first', async () => {
    const dates = (await (await ctx.anon(`/api/articles${AT_8}`)).json()).map((a: any) => a.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('serves published stories only', async () => {
    // §2.2: nothing reaches a child without a human reading it first. This
    // endpoint is unauthenticated, so the guarantee has to hold here.
    const rows = await (await ctx.anon(`/api/articles${AT_8}`)).json();

    expect(rows).toHaveLength(3);
    expect(rows.every((a: any) => a.status === 'published')).toBe(true);
    expect(rows.map((a: any) => a.id)).not.toContain('pending-1');
    expect(rows.map((a: any) => a.id)).not.toContain('rejected-1');
  });

  it('ignores a caller-supplied status, including one asking for unreviewed stories', async () => {
    for (const query of ['?age=8&status=pending_review', '?age=8&status=rejected', '?age=8&status=bogus']) {
      const rows = await (await ctx.anon(`/api/articles${query}`)).json();
      expect(rows.every((a: any) => a.status === 'published')).toBe(true);
    }
  });

  it('still answers the frontend’s existing request unchanged', async () => {
    const rows = await (await ctx.anon(`/api/articles${AT_8}&status=published`)).json();
    expect(rows).toHaveLength(3);
  });

  it('parses JSON columns into real values', async () => {
    const article = (await (await ctx.anon(`/api/articles/flagged-1${AT_8}`)).json());
    expect(Array.isArray(article.vocab)).toBe(true);
    expect(article.vocab[0]).toHaveProperty('word');
    expect(article.contentWarnings).toEqual(['storm']);
    expect(typeof article.editedByHuman).toBe('boolean');
  });

  it('returns null, never undefined, for absent optional fields', async () => {
    const article = await (await ctx.anon(`/api/articles/pub-1${AT_8}`)).json();
    expect(article.feelingNote).toBeNull();
    expect(article.contentWarnings).toBeNull();
    expect(article.rejectReason).toBeNull();
  });
});

describe('GET /api/articles/:id', () => {
  it('returns a single object', async () => {
    const article = await (await ctx.anon(`/api/articles/pub-1${AT_8}`)).json();
    expect(Array.isArray(article)).toBe(false);
    expect(article.id).toBe('pub-1');
  });

  it('404s for an unknown id', async () => {
    const res = await ctx.anon('/api/articles/nope');
    expect(res.status).toBe(404);
    expect(typeof (await res.json()).error).toBe('string');
  });

  it.each([['pending-1'], ['rejected-1']])(
    '404s for %s, which is not published',
    async (id) => {
      // 404 rather than 403: a 403 would confirm the story exists, which lets
      // someone enumerate what is sitting unreviewed in the queue.
      const res = await ctx.anon(`/api/articles/${id}`);
      expect(res.status).toBe(404);
    },
  );
});

describe('unknown routes', () => {
  it('return JSON, not an HTML page', async () => {
    const res = await ctx.anon('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('json');
  });
});

describe('health', () => {
  it('reports ok', async () => {
    expect((await (await ctx.anon('/api/health')).json()).ok).toBe(true);
  });
});

describe('central error handling', () => {
  it('answers malformed JSON with JSON, not an HTML stack trace', async () => {
    const res = await ctx.api('/api/admin/articles/bulk', {
      method: 'POST',
      body: '{ this is not json',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('json');
    expect(await res.json()).toEqual({ error: 'Request body is not valid JSON.' });
  });

  it('never leaks a stack trace or a file path', async () => {
    const text = await (await ctx.api('/api/admin/articles/bulk', { method: 'POST', body: '{ bad' })).text();
    expect(text).not.toMatch(/node_modules|\/home\/|at .*\(/);
  });
});

describe('one version per reading age (§6)', () => {
  /** A published story with one version per given age. */
  const seedStory = (rawId: string, ages: number[]) => {
    const raw = insertRawArticle(ctx.db, {
      id: rawId, headline: `Adult headline ${rawId}`, simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    for (const age of ages) {
      insertKidArticle(ctx.db, {
        id: `${rawId}-v${age}`, originalId: raw, ageTarget: age, status: 'published',
        kidHeadline: `Written for age ${age}`, createdAt: '2026-09-07T10:00:00.000Z',
      });
    }
    return raw;
  };

  const storyFrom = (rows: any[], rawId: string) => rows.filter((a) => a.originalId === rawId);

  it('serves the version written for the requested age', async () => {
    const raw = seedStory('ages-all', [5, 6, 7, 8]);

    const rows = await (await ctx.anon('/api/articles?age=7')).json();
    const mine = storyFrom(rows, raw);

    // One entry for the story, not four.
    expect(mine).toHaveLength(1);
    expect(mine[0].kidHeadline).toBe('Written for age 7');
    expect(mine[0].ageTarget).toBe(7);
  });

  it('serves a different version for every age', async () => {
    const raw = seedStory('ages-each', [5, 9, 14]);

    for (const age of [5, 9, 14]) {
      const rows = await (await ctx.anon(`/api/articles?age=${age}`)).json();
      expect(storyFrom(rows, raw)[0].kidHeadline).toBe(`Written for age ${age}`);
    }
  });

  it('omits a story that has no version for the requested age', async () => {
    // Exact match only: a story exists in one version per age, so a missing age
    // means the story was never simplified for that reader. No nearest-age
    // guessing — showing an age-12 rewrite to a five-year-old is worse than
    // showing nothing.
    const raw = seedStory('ages-gap', [5, 12]);

    const rows = await (await ctx.anon('/api/articles?age=8')).json();

    expect(storyFrom(rows, raw)).toHaveLength(0);
  });

  it('never serves an unpublished version', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'ages-unpub', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, {
      id: 'ages-unpub-v9', originalId: raw, ageTarget: 9, status: 'pending_review',
      kidHeadline: 'Unreviewed age 9',
    });

    const rows = await (await ctx.anon('/api/articles?age=9')).json();

    expect(storyFrom(rows, raw)).toHaveLength(0);
  });

  it.each([['?age=99'], ['?age=abc'], ['?age=-3'], ['?age='], ['']])(
    'falls back to the default age for %s rather than erroring',
    async (query) => {
      const res = await ctx.anon(`/api/articles${query}`);

      // A public read path for a children's site answers, rather than 400ing
      // because a query string was odd.
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    },
  );
});

describe('GET /api/articles/:id?age= (§6)', () => {
  it('serves the sibling version for the requested age', async () => {
    // The slider has to keep working when a reader is already on a story page:
    // the id names one version, but the reader wants that STORY at their age.
    const raw = insertRawArticle(ctx.db, {
      id: 'detail-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, {
      id: 'detail-v5', originalId: raw, ageTarget: 5, status: 'published',
      kidHeadline: 'Written for age 5',
    });
    insertKidArticle(ctx.db, {
      id: 'detail-v14', originalId: raw, ageTarget: 14, status: 'published',
      kidHeadline: 'Written for age 14',
    });

    const article = await (await ctx.anon('/api/articles/detail-v5?age=14')).json();

    expect(article.kidHeadline).toBe('Written for age 14');
  });

  it('404s when the story has no version for that age', async () => {
    // Consistent with the feed, which omits it: a reader cannot reach a page
    // the feed would not have offered them.
    expect((await ctx.anon('/api/articles/detail-v5?age=9')).status).toBe(404);
  });

  it('still 404s for an unpublished story', async () => {
    expect((await ctx.anon('/api/articles/pending-1?age=8')).status).toBe(404);
  });

  it('still 404s for an unknown id', async () => {
    expect((await ctx.anon('/api/articles/nope?age=8')).status).toBe(404);
  });
});
