/**
 * Which stories make today's podcast episode: the published versions for a
 * band from the most recent LOCAL day that has any (spec §3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDate } from '../src/core/localDate.js';
import { createArticleRepository } from '../src/db/repositories/articleRepository.js';
import { createTestContext, insertKidArticle, type TestContext } from './helpers.js';

describe('localDate', () => {
  it('is the calendar date in the given zone, not in UTC', () => {
    // 02:00 UTC on the 29th is still the evening of the 28th in New York.
    expect(localDate('2026-09-29T02:00:00.000Z', 'America/New_York')).toBe('2026-09-28');
    // And 20:00 UTC on the 28th is already the 29th in Kathmandu (+05:45).
    expect(localDate('2026-09-28T20:00:00.000Z', 'Asia/Kathmandu')).toBe('2026-09-29');
    expect(localDate('2026-09-28T23:30:00.000Z', 'UTC')).toBe('2026-09-28');
  });
});

describe('listLatestPublishedDayForAge', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => ctx.close());

  const publish = (id: string, publishedAt: string, extra: Record<string, unknown> = {}) =>
    insertKidArticle(ctx.db, { id, status: 'published', publishedAt, ...extra });

  const day = (timeZone = 'UTC', limit = 8) =>
    createArticleRepository(ctx.db).listLatestPublishedDayForAge(8, timeZone, limit);

  it('takes only the most recent day, oldest story first', () => {
    publish('yesterday', '2026-09-27T09:00:00.000Z');
    publish('today-late', '2026-09-28T15:00:00.000Z');
    publish('today-early', '2026-09-28T08:00:00.000Z');

    const result = day();

    expect(result.date).toBe('2026-09-28');
    expect(result.articles.map((a) => a.id)).toEqual(['today-early', 'today-late']);
  });

  it('falls back to the latest day that has stories when today has none', () => {
    // Nothing published "today" is not a special case: the newest story's day
    // simply is the episode's day.
    publish('older', '2026-09-25T09:00:00.000Z');
    publish('latest', '2026-09-26T09:00:00.000Z');

    const result = day();

    expect(result.date).toBe('2026-09-26');
    expect(result.articles.map((a) => a.id)).toEqual(['latest']);
  });

  it('measures the day in the configured zone', () => {
    // Both are Sep 28 in New York, but different UTC days.
    publish('ny-morning', '2026-09-28T15:00:00.000Z');
    publish('ny-night', '2026-09-29T02:00:00.000Z');

    expect(day('America/New_York').articles.map((a) => a.id)).toEqual(['ny-morning', 'ny-night']);
    expect(day('UTC').articles.map((a) => a.id)).toEqual(['ny-night']);
  });

  it('never includes a story that is not published, or another band', () => {
    publish('ok', '2026-09-28T09:00:00.000Z');
    insertKidArticle(ctx.db, { id: 'pending', status: 'pending_review' });
    insertKidArticle(ctx.db, { id: 'rejected', status: 'rejected' });
    publish('older-readers', '2026-09-28T10:00:00.000Z', { ageTarget: 11 });

    expect(day().articles.map((a) => a.id)).toEqual(['ok']);
  });

  it('keeps the newest stories when a day has more than the cap', () => {
    // The newest story must always make the episode, or publishing one more
    // on a busy day would change nothing a child hears.
    for (let hour = 1; hour <= 5; hour += 1) {
      publish(`s${hour}`, `2026-09-28T0${hour}:00:00.000Z`);
    }

    expect(day('UTC', 3).articles.map((a) => a.id)).toEqual(['s3', 's4', 's5']);
  });

  it('is empty, with no date, when nothing has ever been published', () => {
    expect(day()).toEqual({ date: null, articles: [] });
  });
});
