import type { Database } from 'better-sqlite3';

export type EpisodeSource = 'llm' | 'fallback';

export interface StoredEpisode {
  key: string;
  ageTarget: number;
  date: string;
  articleIds: string[];
  script: string;
  source: EpisodeSource;
  reason: string | null;
  model: string | null;
  costUsd: number | null;
  retryAfter: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredEpisodeRow extends Omit<StoredEpisode, 'articleIds'> {
  articleIds: string;
}

export interface EpisodeRepository {
  findByKey(key: string): StoredEpisode | undefined;
  upsert(episode: StoredEpisode): void;
}

export function createEpisodeRepository(db: Database): EpisodeRepository {
  const statements = {
    byKey: db.prepare(`SELECT * FROM podcast_episodes WHERE key = ?`),
    upsert: db.prepare(
      `INSERT INTO podcast_episodes
         (key, ageTarget, date, articleIds, script, source, reason, model, costUsd,
          retryAfter, attempts, createdAt, updatedAt)
       VALUES
         (@key, @ageTarget, @date, @articleIds, @script, @source, @reason, @model, @costUsd,
          @retryAfter, @attempts, @createdAt, @updatedAt)
       ON CONFLICT (key) DO UPDATE SET
         script = excluded.script, source = excluded.source, reason = excluded.reason,
         model = excluded.model, costUsd = excluded.costUsd, retryAfter = excluded.retryAfter,
         attempts = excluded.attempts, updatedAt = excluded.updatedAt`,
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
