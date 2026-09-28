/** podcast_episodes: the stored episode script (spec §6). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEpisodeRepository, type StoredEpisode } from '../src/db/repositories/episodeRepository.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

const EPISODE: StoredEpisode = {
  key: 'k1', ageTarget: 8, date: '2026-09-28', articleIds: ['a1', 'a2'],
  script: 'Hello friends.', source: 'fallback', reason: 'The model timed out.', model: null,
  costUsd: null, retryAfter: '2026-09-28T12:10:00.000Z',
  createdAt: '2026-09-28T12:00:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z',
};

describe('episode repository', () => {
  it('round-trips an episode, article ids and all', () => {
    const episodes = createEpisodeRepository(ctx.db);
    episodes.upsert(EPISODE);

    expect(episodes.findByKey('k1')).toEqual(EPISODE);
  });

  it('misses cleanly for an episode never written', () => {
    expect(createEpisodeRepository(ctx.db).findByKey('nope')).toBeUndefined();
  });

  it('replaces a temporary fallback in place, keeping when it was first made', () => {
    const episodes = createEpisodeRepository(ctx.db);
    episodes.upsert(EPISODE);

    episodes.upsert({
      ...EPISODE, script: 'Hi, curious friends!', source: 'llm', reason: null, model: 'stub-llm',
      costUsd: 0.002, retryAfter: null,
      createdAt: '2026-09-28T13:00:00.000Z', updatedAt: '2026-09-28T13:00:00.000Z',
    });

    expect(episodes.findByKey('k1')).toMatchObject({
      script: 'Hi, curious friends!', source: 'llm', retryAfter: null,
      createdAt: '2026-09-28T12:00:00.000Z', updatedAt: '2026-09-28T13:00:00.000Z',
    });
  });

  it('refuses a source that is neither llm nor fallback', () => {
    expect(() =>
      createEpisodeRepository(ctx.db).upsert({ ...EPISODE, source: 'editor' as never }),
    ).toThrow(/CHECK/);
  });
});
