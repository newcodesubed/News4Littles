/**
 * scripts/migrate-age-bands — collapsing pre-band stories onto AGE_BANDS.
 *
 * The rules that matter: a dry run writes nothing; in every band the row at
 * the anchor is kept, else the youngest; the rest are deleted; an already
 * migrated database is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAgeBands } from '../src/db/migrateAgeBands.js';
import { createSettingsRepository } from '../src/db/repositories/settingsRepository.js';
import { createPromptRepository } from '../src/db/repositories/promptRepository.js';
import {
  countRows, createTestContext, insertKidArticle, insertRawArticle, type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

function seedStory(rawId: string, ages: number[]) {
  insertRawArticle(ctx.db, { id: rawId, simplifiedAt: '2026-09-06T09:00:00.000Z' });
  for (const age of ages) {
    insertKidArticle(ctx.db, { id: `${rawId}-v${age}`, originalId: rawId, ageTarget: age });
  }
}

const agesOf = (rawId: string) =>
  ctx.db.prepare(`SELECT id, ageTarget FROM kid_articles WHERE originalId = ? ORDER BY ageTarget`)
    .all(rawId) as { id: string; ageTarget: number }[];

describe('migrateAgeBands', () => {
  it('collapses a ten-version story to the three anchor rows', () => {
    seedStory('r1', [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    const report = migrateAgeBands(ctx.db, { apply: true });

    expect(report.storiesChanged).toBe(1);
    expect(report.rowsMoved).toEqual([]);
    expect(report.rowsDeleted.map((r) => r.ageTarget)).toEqual([6, 7, 9, 10, 12, 13, 14]);
    expect(agesOf('r1')).toEqual([
      { id: 'r1-v5', ageTarget: 5 }, { id: 'r1-v8', ageTarget: 8 }, { id: 'r1-v11', ageTarget: 11 },
    ]);
  });

  it('moves a single pre-band row onto its band anchor, keeping its id', () => {
    seedStory('r1', [9]);

    migrateAgeBands(ctx.db, { apply: true });

    expect(agesOf('r1')).toEqual([{ id: 'r1-v9', ageTarget: 8 }]);
  });

  it('keeps the youngest row in a band that has no anchor row', () => {
    seedStory('r1', [6, 7]);

    const report = migrateAgeBands(ctx.db, { apply: true });

    expect(report.rowsMoved).toEqual([{ id: 'r1-v6', from: 6, to: 5 }]);
    expect(report.rowsDeleted.map((r) => r.id)).toEqual(['r1-v7']);
    expect(agesOf('r1')).toEqual([{ id: 'r1-v6', ageTarget: 5 }]);
  });

  it('writes nothing on a dry run but still reports the plan', () => {
    seedStory('r1', [5, 6, 7]);

    const report = migrateAgeBands(ctx.db, { apply: false });

    expect(report.rowsDeleted).toHaveLength(2);
    expect(countRows(ctx.db, 'kid_articles')).toBe(3);
  });

  it('is a no-op on an already migrated database', () => {
    seedStory('r1', [5, 8, 11]);
    seedStory('r2', [8]);

    const report = migrateAgeBands(ctx.db, { apply: true });

    expect(report.storiesChanged).toBe(0);
    expect(report.rowsMoved).toEqual([]);
    expect(report.rowsDeleted).toEqual([]);
    expect(countRows(ctx.db, 'kid_articles')).toBe(4);
  });

  it('leaves other stories alone', () => {
    seedStory('r1', [5, 6]);
    seedStory('r2', [5, 8, 11]);

    migrateAgeBands(ctx.db, { apply: true });

    expect(agesOf('r2').map((r) => r.ageTarget)).toEqual([5, 8, 11]);
  });

  it('re-keys a per-age prompt override to its band anchor', () => {
    const settings = createSettingsRepository(ctx.db);
    settings.savePromptConfig(
      { genericPrompt: 'G', ageOverrides: { '6': 'six', '12': 'twelve' } },
      '2026-09-06T09:00:00.000Z',
    );

    const report = migrateAgeBands(ctx.db, { apply: true });

    expect(report.overridesMoved).toEqual([{ from: '6', to: '5' }, { from: '12', to: '11' }]);
    expect(settings.getPromptConfig().ageOverrides).toEqual({ '5': 'six', '11': 'twelve' });
  });

  it('keeps an existing anchor override over a re-keyed one, and says so', () => {
    const settings = createSettingsRepository(ctx.db);
    settings.savePromptConfig(
      { genericPrompt: 'G', ageOverrides: { '6': 'six', '5': 'five' } },
      '2026-09-06T09:00:00.000Z',
    );

    const report = migrateAgeBands(ctx.db, { apply: true });

    expect(report.overridesDropped).toEqual(['6']);
    expect(settings.getPromptConfig().ageOverrides).toEqual({ '5': 'five' });
  });

  it('re-keys prompt drafts the same way and drops a colliding one', () => {
    const prompts = createPromptRepository(ctx.db);
    prompts.saveDraft({ target: 'simplification', age: 6, promptText: 'six' }, '2026-09-06T09:00:00.000Z');
    prompts.saveDraft({ target: 'simplification', age: 9, promptText: 'nine' }, '2026-09-06T09:00:00.000Z');
    prompts.saveDraft({ target: 'simplification', age: 8, promptText: 'eight' }, '2026-09-06T09:00:00.000Z');

    const report = migrateAgeBands(ctx.db, { apply: true });

    expect(report.draftsMoved).toEqual([{ from: 6, to: 5 }]);
    expect(report.draftsDropped).toEqual([9]);
    expect(prompts.listDrafts().map((d) => [d.age, d.promptText])).toEqual([[5, 'six'], [8, 'eight']]);
  });
});
