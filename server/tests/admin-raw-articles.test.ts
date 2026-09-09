/**
 * The raw-article backlog API: what is waiting, and simplifying it on demand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRawArticleRepository } from '../src/db/repositories/rawArticleRepository.js';
import { acquireJob, releaseJob } from '../src/services/jobLock.js';
import { resetSimplifyJob, type SimplifyJobState } from '../src/services/simplifyService.js';
import {
  countRows, createTestContext, insertRawArticle, type TestContext,
} from './helpers.js';

let ctx: TestContext;

const seedWaiting = (id: string, over: Record<string, unknown> = {}) =>
  insertRawArticle(ctx.db, {
    id,
    headline: `Adult headline ${id}`,
    body: 'A rover surveyed the reef and found the coral healthy this year.',
    url: `https://example.com/${id}`,
    publishedAt: '2026-09-08T00:00:00.000Z',
    simplifiedAt: null,
    ...over,
  });

/** Polls the job endpoint until the batch reports itself finished. */
async function waitForJob(): Promise<{ running: boolean; job: SimplifyJobState }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = (await (await ctx.api('/api/admin/raw-articles/simplify/status')).json()) as
      { running: boolean; job: SimplifyJobState | null };
    if (body.job && !body.running) return { running: body.running, job: body.job };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the simplification job never finished');
}

beforeEach(() => { ctx = createTestContext(); resetSimplifyJob(); });
afterEach(() => { ctx.close(); resetSimplifyJob(); });

describe('GET /api/admin/raw-articles/waiting', () => {
  it('needs admin auth', async () => {
    expect((await ctx.anon('/api/admin/raw-articles/waiting')).status).toBe(401);
  });

  it('lists unsimplified articles with a total', async () => {
    seedWaiting('r1');
    seedWaiting('r2', { simplifiedAt: '2026-09-09T00:00:00.000Z' });

    const body = await (await ctx.api('/api/admin/raw-articles/waiting')).json();

    expect(body.total).toBe(1);
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0]).toMatchObject({
      id: 'r1', sourceId: 'bbc', sourceName: 'BBC News', headline: 'Adult headline r1',
    });
    expect(body.articles[0].bodyLength).toBeGreaterThan(0);
  });

  it('filters by source and caps the limit', async () => {
    seedWaiting('r1');
    seedWaiting('m1', { sourceId: 'manual', sourceName: 'Manual submission' });

    const filtered = await (await ctx.api('/api/admin/raw-articles/waiting?source=manual')).json();
    expect(filtered.articles.map((a: { id: string }) => a.id)).toEqual(['m1']);

    // A caller asking for a million rows gets the ceiling, not a million rows.
    const capped = await (await ctx.api('/api/admin/raw-articles/waiting?limit=100000')).json();
    expect(capped.articles.length).toBeLessThanOrEqual(200);
  });
});

describe('POST /api/admin/raw-articles/simplify', () => {
  it('starts a background job and simplifies exactly the ids given', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    const res = await ctx.api('/api/admin/raw-articles/simplify', {
      method: 'POST',
      body: JSON.stringify({ ids: ['r1'] }),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).running).toBe(true);

    const finished = await waitForJob();
    expect(finished.job.report.simplified).toHaveLength(1);
    expect(countRows(ctx.db, 'kid_articles')).toBe(1);
    // r2 was not selected, so it is still waiting.
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);
  });

  it('rejects a missing or empty selection', async () => {
    for (const body of [{}, { ids: [] }, { ids: 'r1' }, { ids: [1, 2] }]) {
      const res = await ctx.api('/api/admin/raw-articles/simplify', {
        method: 'POST', body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('returns 409 while a scrape holds the job lock', async () => {
    // The lock is taken directly rather than by starting a real batch: without
    // an LLM configured a one-article batch finishes in well under a
    // millisecond, so racing two HTTP requests against it is not deterministic.
    // What matters here is that the route turns a held lock into a 409.
    seedWaiting('r1');
    acquireJob('scrape');

    try {
      const res = await ctx.api('/api/admin/raw-articles/simplify', {
        method: 'POST', body: JSON.stringify({ ids: ['r1'] }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/already running/);
      // Nothing was spent while the lock was held.
      expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    } finally {
      releaseJob();
    }
  });

  it('needs admin auth', async () => {
    const res = await ctx.anon('/api/admin/raw-articles/simplify', {
      method: 'POST', body: JSON.stringify({ ids: ['r1'] }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/raw-articles', () => {
  it('still serves the sandbox test-article dropdown after the move', async () => {
    seedWaiting('r1');
    const body = await (await ctx.api('/api/admin/raw-articles')).json();
    expect(body.map((a: { id: string }) => a.id)).toContain('r1');
  });
});
