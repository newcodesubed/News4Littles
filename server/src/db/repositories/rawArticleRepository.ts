/** All SQL touching raw_articles (PRD §8.2). */
import type { Database } from 'better-sqlite3';

export interface RawArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  url: string;
  headline: string;
  body: string;
  topic: string;
  publishedAt: string | null;
  fetchedAt: string;
}

const COLUMNS = [
  'id', 'sourceId', 'sourceName', 'sourceUrl', 'url',
  'headline', 'body', 'topic', 'publishedAt', 'fetchedAt',
] as const;

export interface RawArticleRepository {
  insert(article: RawArticle): void;
  findById(id: string): RawArticle | undefined;
  /** §5.2: an item already stored for this source must not be stored twice. */
  existsForSourceUrl(sourceId: string, url: string): boolean;
  countForSource(sourceId: string): number;
}

export function createRawArticleRepository(db: Database): RawArticleRepository {
  const insert = db.prepare(
    `INSERT INTO raw_articles (${COLUMNS.join(', ')})
     VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`,
  );
  const byId = db.prepare(`SELECT * FROM raw_articles WHERE id = ?`);
  const bySourceUrl = db.prepare(`SELECT 1 FROM raw_articles WHERE sourceId = ? AND url = ? LIMIT 1`);
  const countBySource = db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE sourceId = ?`);

  return {
    insert: (article) => void insert.run(article),
    findById: (id) => byId.get(id) as RawArticle | undefined,
    existsForSourceUrl: (sourceId, url) => bySourceUrl.get(sourceId, url) !== undefined,
    countForSource: (sourceId) => countBySource.pluck().get(sourceId) as number,
  };
}
