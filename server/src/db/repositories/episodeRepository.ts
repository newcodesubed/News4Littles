/**
 * Every piece of SQL that touches podcast_episodes.
 *
 * An episode is written once per set of inputs and only ever rewritten to
 * replace a temporary fallback, so the whole API is a lookup and an upsert.
 */
import type { Database } from 'better-sqlite3';

export type EpisodeSource = 'llm' | 'fallback';

export interface StoredEpisode {
  /** The episode key (episodeService.episodeKey). */
  key: string;
  ageTarget: number;
  /** Local YYYY-MM-DD the stories were published on. */
  date: string;
  /** In episode order. */
  articleIds: string[];
  /** Exactly what is spoken. */
  script: string;
  source: EpisodeSource;
  /** Why the fallback was used; null for 'llm'. */
  reason: string | null;
  /** The LLM that wrote it; null for 'fallback'. */
  model: string | null;
  costUsd: number | null;
  /** ISO. Set only on a temporary fallback: after this, the LLM is tried again. */
  retryAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredEpisodeRow extends Omit<StoredEpisode, 'articleIds'> {
  articleIds: string; // JSON text
}

export interface EpisodeRepository {
  findByKey(key: string): StoredEpisode | undefined;
  /** Inserts, or replaces the script of an existing key. createdAt is kept. */
  upsert(episode: StoredEpisode): void;
}

export function createEpisodeRepository(db: Database): EpisodeRepository {
  const statements = {
    byKey: db.prepare(`SELECT * FROM podcast_episodes WHERE key = ?`),
    upsert: db.prepare(
      `INSERT INTO podcast_episodes
         (key, ageTarget, date, articleIds, script, source, reason, model, costUsd,
          retryAfter, createdAt, updatedAt)
       VALUES
         (@key, @ageTarget, @date, @articleIds, @script, @source, @reason, @model, @costUsd,
          @retryAfter, @createdAt, @updatedAt)
       ON CONFLICT (key) DO UPDATE SET
         script = excluded.script, source = excluded.source, reason = excluded.reason,
         model = excluded.model, costUsd = excluded.costUsd, retryAfter = excluded.retryAfter,
         updatedAt = excluded.updatedAt`,
    ),
  };

  return {
    findByKey(key) {
      const row = statements.byKey.get(key) as StoredEpisodeRow | undefined;
      return row && { ...row, articleIds: JSON.parse(row.articleIds) as string[] };
    },

    upsert(episode) {
      statements.upsert.run({ ...episode, articleIds: JSON.stringify(episode.articleIds) });
    },
  };
}
