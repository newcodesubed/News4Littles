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
  /**
   * ISO when a kid article was created from this raw; NULL while it waits.
   * A scrape stores every item but simplifies only app_settings.simplifyBudget
   * of them, so NULL is the backlog this feature exists to manage.
   */
  simplifiedAt: string | null;
}

const COLUMNS = [
  'id', 'sourceId', 'sourceName', 'sourceUrl', 'url',
  'headline', 'body', 'topic', 'publishedAt', 'fetchedAt', 'simplifiedAt',
] as const;

/** One backlog row as the review queue's "Not yet simplified" tab shows it. */
export interface WaitingRawArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  headline: string;
  url: string;
  topic: string;
  publishedAt: string | null;
  fetchedAt: string;
  /** So an editor can spot a one-line stub before spending a call on it. */
  bodyLength: number;
}

export interface RawArticleRepository {
  insert(article: RawArticle): void;
  findById(id: string): RawArticle | undefined;
  /** §5.2: an item already stored for this source must not be stored twice. */
  existsForSourceUrl(sourceId: string, url: string): boolean;
  countForSource(sourceId: string): number;
  /** Unsimplified rows only. Newest publishedAt first; undated last. */
  listWaiting(options?: { sourceId?: string; limit?: number }): WaitingRawArticle[];
  countWaiting(): number;
  countWaitingForSource(sourceId: string): number;
  /** Waiting ids grouped by source, each newest-first: the round-robin input. */
  waitingIdsBySource(): { sourceId: string; rawIds: string[] }[];
  /**
   * Claims a row for simplification. Returns false when it was already claimed,
   * which is how two concurrent submits of the same id cannot both write a kid
   * article for it.
   */
  markSimplified(id: string, at: string): boolean;
}

export function createRawArticleRepository(db: Database): RawArticleRepository {
  const insert = db.prepare(
    `INSERT INTO raw_articles (${COLUMNS.join(', ')})
     VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`,
  );
  const byId = db.prepare(`SELECT * FROM raw_articles WHERE id = ?`);
  const bySourceUrl = db.prepare(`SELECT 1 FROM raw_articles WHERE sourceId = ? AND url = ? LIMIT 1`);
  const countBySource = db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE sourceId = ?`);

  // ORDER BY publishedAt DESC puts NULLs last in SQLite, which is wanted: an
  // undated item is the lowest-priority candidate for a scarce budget.
  const waiting = db.prepare(
    `SELECT r.id, r.sourceId, r.sourceName, r.headline, r.url, r.topic,
            r.publishedAt, r.fetchedAt, LENGTH(r.body) AS bodyLength
     FROM raw_articles r
     WHERE r.simplifiedAt IS NULL
       AND (@sourceId IS NULL OR r.sourceId = @sourceId)
     ORDER BY r.publishedAt DESC, r.fetchedAt DESC, r.id
     LIMIT @limit`,
  );
  const countAllWaiting = db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL`);
  const countSourceWaiting = db.prepare(
    `SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL AND sourceId = ?`,
  );
  const waitingIds = db.prepare(
    `SELECT id, sourceId FROM raw_articles WHERE simplifiedAt IS NULL
     ORDER BY sourceId, publishedAt DESC, fetchedAt DESC, id`,
  );
  // The WHERE clause is the claim: only an unclaimed row is updated.
  const claim = db.prepare(
    `UPDATE raw_articles SET simplifiedAt = @at WHERE id = @id AND simplifiedAt IS NULL`,
  );

  return {
    insert: (article) => void insert.run(article),
    findById: (id) => byId.get(id) as RawArticle | undefined,
    existsForSourceUrl: (sourceId, url) => bySourceUrl.get(sourceId, url) !== undefined,
    countForSource: (sourceId) => countBySource.pluck().get(sourceId) as number,

    listWaiting: ({ sourceId, limit } = {}) =>
      waiting.all({ sourceId: sourceId ?? null, limit: limit ?? 50 }) as WaitingRawArticle[],

    countWaiting: () => countAllWaiting.pluck().get() as number,
    countWaitingForSource: (sourceId) => countSourceWaiting.pluck().get(sourceId) as number,

    waitingIdsBySource() {
      const groups: { sourceId: string; rawIds: string[] }[] = [];
      for (const row of waitingIds.all() as { id: string; sourceId: string }[]) {
        const last = groups[groups.length - 1];
        if (last?.sourceId === row.sourceId) last.rawIds.push(row.id);
        else groups.push({ sourceId: row.sourceId, rawIds: [row.id] });
      }
      return groups;
    },

    markSimplified: (id, at) => claim.run({ id, at }).changes === 1,
  };
}
