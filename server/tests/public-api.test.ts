/** Public article routes — PRD §3, §11.1. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, insertKidArticle, type TestContext } from './helpers.js';

let ctx: TestContext;

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
    expect(Array.isArray(await (await ctx.anon('/api/articles')).json())).toBe(true);
  });

  it('sorts newest first', async () => {
    const dates = (await (await ctx.anon('/api/articles')).json()).map((a: any) => a.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('serves published stories only', async () => {
    // §2.2: nothing reaches a child without a human reading it first. This
    // endpoint is unauthenticated, so the guarantee has to hold here.
    const rows = await (await ctx.anon('/api/articles')).json();

    expect(rows).toHaveLength(3);
    expect(rows.every((a: any) => a.status === 'published')).toBe(true);
    expect(rows.map((a: any) => a.id)).not.toContain('pending-1');
    expect(rows.map((a: any) => a.id)).not.toContain('rejected-1');
  });

  it('ignores a caller-supplied status, including one asking for unreviewed stories', async () => {
    for (const query of ['?status=pending_review', '?status=rejected', '?status=bogus']) {
      const rows = await (await ctx.anon(`/api/articles${query}`)).json();
      expect(rows.every((a: any) => a.status === 'published')).toBe(true);
    }
  });

  it('still answers the frontend’s existing request unchanged', async () => {
    const rows = await (await ctx.anon('/api/articles?status=published')).json();
    expect(rows).toHaveLength(3);
  });

  it('parses JSON columns into real values', async () => {
    const article = (await (await ctx.anon('/api/articles/flagged-1')).json());
    expect(Array.isArray(article.vocab)).toBe(true);
    expect(article.vocab[0]).toHaveProperty('word');
    expect(article.contentWarnings).toEqual(['storm']);
    expect(typeof article.editedByHuman).toBe('boolean');
  });

  it('returns null, never undefined, for absent optional fields', async () => {
    const article = await (await ctx.anon('/api/articles/pub-1')).json();
    expect(article.feelingNote).toBeNull();
    expect(article.contentWarnings).toBeNull();
    expect(article.rejectReason).toBeNull();
  });
});

describe('GET /api/articles/:id', () => {
  it('returns a single object', async () => {
    const article = await (await ctx.anon('/api/articles/pub-1')).json();
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
