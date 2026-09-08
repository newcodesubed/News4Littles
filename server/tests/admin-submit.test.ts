/** Editor portal — PRD §4.3. No LLM: "Simplify with AI" is the local pipeline. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countRows, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

const SUBMISSION = {
  headline: 'Council approves plan after conflict over the reef treaty',
  sourceName: 'The Local Paper',
  sourceUrl: 'https://example.com/reef',
  body: 'The council actually approved the plan. A rover surveyed the reef. There was conflict and an attack near the site.',
  category: 'Environment',
  ageTarget: 8,
};

const post = (path: string, body: unknown) =>
  ctx.api(path, { method: 'POST', body: JSON.stringify(body) });

describe('POST /simplify (§4.3 "Simplify with AI")', () => {
  it('returns generated kid-facing fields', async () => {
    const { article } = await (await post('/api/admin/simplify', SUBMISSION)).json();
    expect(article.kidHeadline).toBeTruthy();
    expect(article.summary).toBeTruthy();
    expect(Array.isArray(article.vocab)).toBe(true);
  });

  it('writes nothing to the database', async () => {
    const before = [countRows(ctx.db, 'raw_articles'), countRows(ctx.db, 'kid_articles')];
    await post('/api/admin/simplify', SUBMISSION);
    expect([countRows(ctx.db, 'raw_articles'), countRows(ctx.db, 'kid_articles')]).toEqual(before);
  });

  it('labels the engine as the local fallback, not a model', async () => {
    const { guard } = await (await post('/api/admin/simplify', SUBMISSION)).json();
    expect(guard.engine).toBe('local-fallback');
  });

  it('applies the same guard as the scraper', async () => {
    const { article, guard } = await (await post('/api/admin/simplify', SUBMISSION)).json();
    expect(guard.matches).toEqual(expect.arrayContaining(['conflict', 'attack']));
    expect(article.safety).toBe('adult-nearby');
    expect(article.feelingNote).toBeTruthy();
  });

  it('applies §9.2 simplification', async () => {
    const { article } = await (await post('/api/admin/simplify', SUBMISSION)).json();
    expect(article.whatHappened).not.toMatch(/\bactually\b/i);
    expect(article.vocab.map((v: any) => v.word)).toContain('reef');
  });
});

describe('POST /articles (§4.3 save)', () => {
  it('files the submission under the manual source', async () => {
    const created = await (await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review' })).json();
    const kid = ctx.db.prepare('SELECT * FROM kid_articles WHERE id = ?').get(created.id) as any;
    const raw = ctx.db.prepare('SELECT * FROM raw_articles WHERE id = ?').get(kid.originalId) as any;

    expect(raw.sourceId).toBe('manual');
    expect(raw.body).toBe(SUBMISSION.body);
    expect(kid.status).toBe('pending_review');
    expect(kid.publishedAt).toBeNull();
  });

  it('appears in the review queue under source=manual', async () => {
    await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review' });
    const { total } = await (await ctx.api('/api/admin/articles?source=manual')).json();
    expect(total).toBe(1);
  });

  it('publishes with a timestamp when asked', async () => {
    const created = await (await post('/api/admin/articles', { ...SUBMISSION, status: 'published' })).json();
    const row = ctx.db.prepare('SELECT * FROM kid_articles WHERE id = ?').get(created.id) as any;
    expect(row.status).toBe('published');
    expect(row.publishedAt).not.toBeNull();
  });

  it('re-runs the guard server-side, so safety cannot be softened from the form', async () => {
    const created = await (await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review', safety: 'calm' })).json();
    const row = ctx.db.prepare('SELECT safety FROM kid_articles WHERE id = ?').get(created.id) as any;
    expect(row.safety).toBe('adult-nearby');
  });

  it('keeps editor text edits and flags them as human', async () => {
    const created = await (await post('/api/admin/articles', {
      ...SUBMISSION, status: 'pending_review', kidHeadline: 'A friendlier headline',
    })).json();
    const row = ctx.db.prepare('SELECT * FROM kid_articles WHERE id = ?').get(created.id) as any;
    expect(row.kidHeadline).toBe('A friendlier headline');
    expect(row.editedByHuman).toBe(1);
  });

  it('leaves editedByHuman false when nothing was changed', async () => {
    const created = await (await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review' })).json();
    const row = ctx.db.prepare('SELECT editedByHuman FROM kid_articles WHERE id = ?').get(created.id) as any;
    expect(row.editedByHuman).toBe(0);
  });

  it.each([
    ['a draft status (§8.3 has no such status)', { status: 'draft' }],
    ['a missing headline', { headline: '' }],
    ['a missing body', { body: '' }],
    ['a missing source name', { sourceName: '' }],
    ['an age above the range', { ageTarget: 99 }],
    ['an age below the range', { ageTarget: 4 }],
    ['malformed vocab', { vocab: ['nope'] }],
  ])('rejects %s with 400', async (_label, patch) => {
    expect((await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review', ...patch })).status).toBe(400);
  });

  it('leaves no orphan raw article when validation fails', async () => {
    const before = countRows(ctx.db, 'raw_articles');
    await post('/api/admin/articles', { ...SUBMISSION, ageTarget: 99 });
    expect(countRows(ctx.db, 'raw_articles')).toBe(before);
  });
});
