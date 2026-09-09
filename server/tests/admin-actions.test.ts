/** Review-queue writes: publish / reject / edit / regenerate / delete / bulk — §4.2. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext, getKidArticle, insertKidArticle, insertRawArticle, type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

const patch = (path: string, body?: unknown) =>
  ctx.api(path, { method: 'PATCH', ...(body ? { body: JSON.stringify(body) } : {}) });

describe('publish / reject / unpublish (§4.2)', () => {
  it('publish sets status and publishedAt', async () => {
    const id = insertKidArticle(ctx.db);
    await patch(`/api/admin/articles/${id}/publish`);
    const row = getKidArticle(ctx.db, id)!;
    expect(row.status).toBe('published');
    expect(row.publishedAt).not.toBeNull();
  });

  it('reject stores the optional reason', async () => {
    const id = insertKidArticle(ctx.db);
    await patch(`/api/admin/articles/${id}/reject`, { reason: 'Not kid news' });
    expect(getKidArticle(ctx.db, id)).toMatchObject({ status: 'rejected', rejectReason: 'Not kid news' });
  });

  it('reject works without a reason', async () => {
    const id = insertKidArticle(ctx.db);
    await patch(`/api/admin/articles/${id}/reject`, {});
    expect(getKidArticle(ctx.db, id)).toMatchObject({ status: 'rejected', rejectReason: null });
  });

  it('unpublish returns an item to the queue and clears publishedAt', async () => {
    const id = insertKidArticle(ctx.db, { status: 'published' });
    await patch(`/api/admin/articles/${id}/unpublish`);
    expect(getKidArticle(ctx.db, id)).toMatchObject({ status: 'pending_review', publishedAt: null });
  });

  it('re-review clears a stale reject reason', async () => {
    const id = insertKidArticle(ctx.db, { status: 'rejected', rejectReason: 'Too grim' });
    await patch(`/api/admin/articles/${id}/unpublish`);
    expect(getKidArticle(ctx.db, id)!.rejectReason).toBeNull();
  });

  it.each(['publish', 'reject', 'unpublish'])('%s 404s for an unknown id', async (action) => {
    expect((await patch(`/api/admin/articles/ghost/${action}`, {})).status).toBe(404);
  });
});

describe('edit (§4.2)', () => {
  it('saves fields and marks the article human-edited', async () => {
    const id = insertKidArticle(ctx.db);
    const res = await patch(`/api/admin/articles/${id}`, {
      kidHeadline: 'A friendlier headline',
      vocab: [{ word: 'reef', definition: 'A rocky ridge under the sea.' }],
      readingMinutes: 2,
    });
    expect(res.status).toBe(200);

    const row = getKidArticle(ctx.db, id)!;
    expect(row.kidHeadline).toBe('A friendlier headline');
    expect(row.readingMinutes).toBe(2);
    expect(row.editedByHuman).toBe(1);
    expect(JSON.parse(row.vocab as string)[0].word).toBe('reef');
  });

  it('returns the article with vocab already parsed', async () => {
    const id = insertKidArticle(ctx.db);
    const body = await (await patch(`/api/admin/articles/${id}`, { summary: 'New summary.' })).json();
    expect(Array.isArray(body.vocab)).toBe(true);
  });

  it.each([
    ['an empty headline', { kidHeadline: '   ' }],
    ['an unknown safety', { safety: 'scary' }],
    ['an out-of-range age', { ageTarget: 99 }],
    ['zero reading minutes', { readingMinutes: 0 }],
    ['malformed vocab', { vocab: ['nope'] }],
    ['malformed contentWarnings', { contentWarnings: [1, 2] }],
    ['no fields at all', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const id = insertKidArticle(ctx.db);
    expect((await patch(`/api/admin/articles/${id}`, body)).status).toBe(400);
  });
});

describe('regenerate (§4.2)', () => {
  it('previews without writing', async () => {
    const id = insertKidArticle(ctx.db, { kidHeadline: 'Original stored headline' });
    const before = JSON.stringify(getKidArticle(ctx.db, id));

    const body = await (await ctx.api(`/api/admin/articles/${id}/regenerate`, { method: 'POST' })).json();
    expect(body.current).toBeTruthy();
    expect(body.generated).toBeTruthy();
    expect(JSON.stringify(getKidArticle(ctx.db, id))).toBe(before);
  });

  it('apply writes the regenerated content and clears editedByHuman', async () => {
    const id = insertKidArticle(ctx.db, { kidHeadline: 'Human edited', editedByHuman: true });
    const { generated } = await (await ctx.api(`/api/admin/articles/${id}/regenerate`, { method: 'POST' })).json();

    await ctx.api(`/api/admin/articles/${id}/regenerate/apply`, { method: 'POST' });
    const row = getKidArticle(ctx.db, id)!;
    expect(row.kidHeadline).toBe(generated.kidHeadline);
    expect(row.editedByHuman).toBe(0);
  });

  it('apply preserves status and publishedAt', async () => {
    const id = insertKidArticle(ctx.db, { status: 'published' });
    const before = getKidArticle(ctx.db, id)!;
    await ctx.api(`/api/admin/articles/${id}/regenerate/apply`, { method: 'POST' });
    expect(getKidArticle(ctx.db, id)).toMatchObject({ status: 'published', publishedAt: before.publishedAt });
  });

  it('keeps the original article link, rather than swapping in the feed URL', async () => {
    // raw.sourceUrl is the rss.xml; raw.url is the story. Regenerating must not
    // replace a working "Read the original" link with a link to raw XML.
    const rawId = insertRawArticle(ctx.db, {
      url: 'https://www.bbc.co.uk/news/articles/the-actual-story',
      sourceUrl: 'https://feeds.bbci.co.uk/news/rss.xml',
      simplifiedAt: '2026-09-04T09:00:00.000Z',
    });
    const id = insertKidArticle(ctx.db, {
      originalId: rawId, sourceUrl: 'https://www.bbc.co.uk/news/articles/the-actual-story',
    });

    await ctx.api(`/api/admin/articles/${id}/regenerate/apply`, { method: 'POST' });

    expect(getKidArticle(ctx.db, id)!.sourceUrl)
      .toBe('https://www.bbc.co.uk/news/articles/the-actual-story');
  });

  it('404s for an unknown id', async () => {
    expect((await ctx.api('/api/admin/articles/ghost/regenerate', { method: 'POST' })).status).toBe(404);
  });
});

describe('delete (§4.2)', () => {
  it('refuses a published article', async () => {
    const id = insertKidArticle(ctx.db, { status: 'published' });
    const res = await ctx.api(`/api/admin/articles/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/[Uu]npublish/);
    expect(getKidArticle(ctx.db, id)).toBeTruthy();
  });

  it.each(['pending_review', 'rejected'])('deletes a %s article', async (status) => {
    const id = insertKidArticle(ctx.db, { status });
    expect((await ctx.api(`/api/admin/articles/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(getKidArticle(ctx.db, id)).toBeUndefined();
  });
});

describe('bulk actions (§4.2)', () => {
  const bulk = (body: unknown) => ctx.api('/api/admin/articles/bulk', { method: 'POST', body: JSON.stringify(body) });

  it('excludes skip-young from approve by default, and says so', async () => {
    const safe = insertKidArticle(ctx.db, { safety: 'calm' });
    const flagged = insertKidArticle(ctx.db, { safety: 'skip-young' });

    const result = await (await bulk({ ids: [safe, flagged], action: 'approve' })).json();
    expect(result.applied).toEqual([safe]);
    expect(result.skipped).toEqual([{ id: flagged, reason: 'flagged skip-young' }]);
    expect(getKidArticle(ctx.db, flagged)!.status).toBe('pending_review');
  });

  it('includes skip-young only when explicitly asked', async () => {
    const flagged = insertKidArticle(ctx.db, { safety: 'skip-young' });
    await bulk({ ids: [flagged], action: 'approve', includeFlagged: true });
    expect(getKidArticle(ctx.db, flagged)!.status).toBe('published');
  });

  it('bulk reject stores one reason across the batch', async () => {
    const a = insertKidArticle(ctx.db);
    const b = insertKidArticle(ctx.db);
    await bulk({ ids: [a, b], action: 'reject', reason: 'batch reject' });
    expect(getKidArticle(ctx.db, a)!.rejectReason).toBe('batch reject');
    expect(getKidArticle(ctx.db, b)!.status).toBe('rejected');
  });

  it('bulk delete skips published items', async () => {
    const pending = insertKidArticle(ctx.db, { status: 'pending_review' });
    const published = insertKidArticle(ctx.db, { status: 'published' });

    const result = await (await bulk({ ids: [pending, published], action: 'delete' })).json();
    expect(result.applied).toEqual([pending]);
    expect(result.skipped[0].reason).toMatch(/published/);
    expect(getKidArticle(ctx.db, published)).toBeTruthy();
  });

  it('reports an unknown id instead of failing the batch', async () => {
    const ok = insertKidArticle(ctx.db);
    const result = await (await bulk({ ids: [ok, 'ghost'], action: 'approve' })).json();
    expect(result.applied).toEqual([ok]);
    expect(result.skipped).toEqual([{ id: 'ghost', reason: 'not found' }]);
  });

  it.each([
    ['empty ids', { ids: [], action: 'approve' }],
    ['unknown action', { ids: ['x'], action: 'nuke' }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await bulk(body)).status).toBe(400);
  });
});
