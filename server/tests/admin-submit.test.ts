/** Editor portal — PRD §4.3. No LLM: "Simplify with AI" is the local pipeline. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countRows, createTestContext, type TestContext } from './helpers.js';
import { AGE_BANDS, AGE_BAND_ANCHORS } from '../src/core/article.js';

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

  it('appears in the review queue as ONE story with every band version', async () => {
    await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review' });

    // Three versions, but one row in the grouped queue an editor actually reads.
    const { total } = await (await ctx.api('/api/admin/articles?source=manual')).json();
    expect(total).toBe(AGE_BANDS.length);
    const { stories } = await (await ctx.api('/api/admin/stories?source=manual')).json();
    expect(stories).toHaveLength(1);
    expect(stories[0].versions).toHaveLength(AGE_BANDS.length);
  });

  it('creates one version per reading band, so Regenerate can rebuild them all', async () => {
    const created = await (await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review' })).json();

    const rows = ctx.db
      .prepare('SELECT ageTarget, originalId FROM kid_articles ORDER BY ageTarget')
      .all() as { ageTarget: number; originalId: string }[];

    expect(rows.map((r) => r.ageTarget)).toEqual([...AGE_BAND_ANCHORS]);
    // One story: every version shares the submitted raw article.
    expect(new Set(rows.map((r) => r.originalId)).size).toBe(1);
    // The response is the band the editor reviewed on the form.
    expect(
      (ctx.db.prepare('SELECT ageTarget FROM kid_articles WHERE id = ?').get(created.id) as { ageTarget: number })
        .ageTarget,
    ).toBe(SUBMISSION.ageTarget);
  });

  it("applies the editor's text to the band they reviewed and no other", async () => {
    // §4.3's form reviews ONE band, so their wording belongs to that band alone
    // — and editedByHuman stays a per-version flag (§5).
    await post('/api/admin/articles', {
      ...SUBMISSION, status: 'pending_review', kidHeadline: 'A friendlier headline',
    });

    const reviewed = ctx.db
      .prepare('SELECT kidHeadline, editedByHuman FROM kid_articles WHERE ageTarget = ?')
      .get(SUBMISSION.ageTarget) as { kidHeadline: string; editedByHuman: number };
    expect(reviewed).toMatchObject({ kidHeadline: 'A friendlier headline', editedByHuman: 1 });

    const others = ctx.db
      .prepare('SELECT kidHeadline, editedByHuman FROM kid_articles WHERE ageTarget != ?')
      .all(SUBMISSION.ageTarget) as { kidHeadline: string; editedByHuman: number }[];
    expect(others).toHaveLength(AGE_BANDS.length - 1);
    expect(others.every((r) => r.kidHeadline !== 'A friendlier headline')).toBe(true);
    expect(others.every((r) => r.editedByHuman === 0)).toBe(true);
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

  it('stores a null audioScript when the local pipeline wrote the version', async () => {
    await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review' });

    const rows = ctx.db
      .prepare('SELECT audioScript FROM kid_articles')
      .all() as { audioScript: string | null }[];

    // No LLM in this test, so §9.2 ran: a story, but nothing to speak.
    expect(rows).toHaveLength(AGE_BANDS.length);
    expect(rows.every((r) => r.audioScript === null)).toBe(true);
  });

  it.each([
    ['a draft status (§8.3 has no such status)', { status: 'draft' }],
    ['a missing headline', { headline: '' }],
    ['a missing body', { body: '' }],
    ['a missing source name', { sourceName: '' }],
    ['an age above the range', { ageTarget: 99 }],
    ['an age below the range', { ageTarget: 4 }],
    // A version is stored under its band anchor; age 6 would be unreachable.
    ['an age that is not a band anchor', { ageTarget: 6 }],
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
