/**
 * Story-scoped row actions (§5).
 *
 * A story is one raw article's age versions. An editor approves the story, so
 * every version has to move together — and the skip-young opt-in has to be
 * judged on the story's strictest version, not on whichever one was clicked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countRows, createTestContext, getKidArticle, insertKidArticle, insertRawArticle,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

/** A story with one version per given age. Returns the version ids by age. */
function seedStory(
  rawId: string,
  ages: number[],
  overrides: Record<number, Record<string, unknown>> = {},
) {
  const raw = insertRawArticle(ctx.db, {
    id: rawId, headline: `Adult headline ${rawId}`, simplifiedAt: '2026-09-06T09:00:00.000Z',
  });
  const ids: Record<number, string> = {};
  for (const age of ages) {
    ids[age] = insertKidArticle(ctx.db, {
      id: `${rawId}-v${age}`, originalId: raw, ageTarget: age,
      kidHeadline: `Version for ${age}`, ...(overrides[age] ?? {}),
    });
  }
  return ids;
}

const statuses = (rawId: string) =>
  ctx.db.prepare(`SELECT DISTINCT status FROM kid_articles WHERE originalId = ?`)
    .pluck().all(rawId);

describe('publishing a story', () => {
  it('publishes every version, not just the one clicked', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const res = await ctx.api(`/api/admin/articles/${ids[8]}/publish`, { method: 'PATCH' });
    expect(res.status).toBe(200);

    expect(statuses('s1')).toEqual(['published']);
    // §4.2: a published row must carry publishedAt, and the schema CHECK
    // enforces it — so every version needs one, not just the clicked version.
    const withoutDate = ctx.db
      .prepare(`SELECT COUNT(*) c FROM kid_articles WHERE originalId = 's1' AND publishedAt IS NULL`)
      .pluck().get();
    expect(withoutDate).toBe(0);
  });

  it('leaves other stories alone', async () => {
    const ids = seedStory('s1', [5, 8]);
    seedStory('s2', [5, 8]);

    await ctx.api(`/api/admin/articles/${ids[5]}/publish`, { method: 'PATCH' });

    expect(statuses('s1')).toEqual(['published']);
    expect(statuses('s2')).toEqual(['pending_review']);
  });
});

describe('rejecting, unpublishing and deleting a story', () => {
  it('rejects every version with the same reason', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    await ctx.api(`/api/admin/articles/${ids[14]}/reject`, {
      method: 'PATCH', body: JSON.stringify({ reason: 'Too grim' }),
    });

    expect(statuses('s1')).toEqual(['rejected']);
    const reasons = ctx.db
      .prepare(`SELECT DISTINCT rejectReason FROM kid_articles WHERE originalId = 's1'`)
      .pluck().all();
    expect(reasons).toEqual(['Too grim']);
  });

  it('returns every version to the queue', async () => {
    const ids = seedStory('s1', [5, 8]);
    await ctx.api(`/api/admin/articles/${ids[5]}/publish`, { method: 'PATCH' });

    await ctx.api(`/api/admin/articles/${ids[8]}/unpublish`, { method: 'PATCH' });

    expect(statuses('s1')).toEqual(['pending_review']);
    const dates = ctx.db
      .prepare(`SELECT DISTINCT publishedAt FROM kid_articles WHERE originalId = 's1'`)
      .pluck().all();
    expect(dates).toEqual([null]);
  });

  it('deletes every version', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const res = await ctx.api(`/api/admin/articles/${ids[5]}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    // The raw article survives, so the story can be simplified again (§4.2).
    expect(countRows(ctx.db, 'raw_articles')).toBe(1);
  });

  it('refuses to delete a published story', async () => {
    const ids = seedStory('s1', [5, 8]);
    await ctx.api(`/api/admin/articles/${ids[5]}/publish`, { method: 'PATCH' });

    const res = await ctx.api(`/api/admin/articles/${ids[8]}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect(countRows(ctx.db, 'kid_articles')).toBe(2);
  });
});

describe('editing one version', () => {
  it('changes only the version edited', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    await ctx.api(`/api/admin/articles/${ids[8]}`, {
      method: 'PATCH', body: JSON.stringify({ kidHeadline: 'Reworded for eights' }),
    });

    expect(getKidArticle(ctx.db, ids[8])!.kidHeadline).toBe('Reworded for eights');
    expect(getKidArticle(ctx.db, ids[5])!.kidHeadline).toBe('Version for 5');
    expect(getKidArticle(ctx.db, ids[14])!.kidHeadline).toBe('Version for 14');
    // editedByHuman stays per-version: only age 8 was touched by a person.
    expect(getKidArticle(ctx.db, ids[8])!.editedByHuman).toBe(1);
    expect(getKidArticle(ctx.db, ids[5])!.editedByHuman).toBe(0);
  });
});

describe('bulk actions over stories', () => {
  it('approving one version of a story approves the story', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const res = await ctx.api('/api/admin/articles/bulk', {
      method: 'POST', body: JSON.stringify({ ids: [ids[8]], action: 'approve' }),
    });
    expect(res.status).toBe(200);

    expect(statuses('s1')).toEqual(['published']);
  });

  it('skips a story whose STRICTEST version is skip-young, even when the selected version is calm', async () => {
    // The safety hole story-scoping would otherwise open: the editor selects
    // the calm age-14 row and unknowingly publishes a skip-young age-5 one.
    const ids = seedStory('s1', [5, 14], {
      5: { safety: 'skip-young', feelingNote: 'A gentle note.' },
      14: { safety: 'calm' },
    });

    const body = await (await ctx.api('/api/admin/articles/bulk', {
      method: 'POST', body: JSON.stringify({ ids: [ids[14]], action: 'approve' }),
    })).json();

    expect(body.skippedCount).toBe(1);
    expect(body.skipped[0].reason).toMatch(/skip-young/);
    expect(statuses('s1')).toEqual(['pending_review']);
  });

  it('publishes that story when the editor opts in', async () => {
    const ids = seedStory('s1', [5, 14], {
      5: { safety: 'skip-young', feelingNote: 'A gentle note.' },
      14: { safety: 'calm' },
    });

    await ctx.api('/api/admin/articles/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [ids[14]], action: 'approve', includeFlagged: true }),
    });

    expect(statuses('s1')).toEqual(['published']);
  });

  it('counts a story once even when several of its versions are selected', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const body = await (await ctx.api('/api/admin/articles/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [ids[5], ids[8], ids[14]], action: 'approve' }),
    })).json();

    // One story approved, not three.
    expect(body.appliedCount).toBe(1);
    expect(statuses('s1')).toEqual(['published']);
  });
});
