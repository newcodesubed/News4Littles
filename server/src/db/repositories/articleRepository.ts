/**
 * Every piece of SQL that touches kid_articles.
 *
 * Before this existed the 21-column INSERT was written out three times (the
 * scraper, the seed script and the editor portal) and the JSON/boolean
 * marshalling four times. Callers now pass a KidArticle and never see a column
 * name.
 */
import type { Database } from 'better-sqlite3';
import {
  toKidArticle, toKidArticleRow,
  type ArticleStatus, type KidArticle, type KidArticleRow, type Safety,
} from '../../core/article.js';

/** Columns the review queue needs that do not live on kid_articles. */
export interface AdminArticleRow extends KidArticleRow {
  sourceId: string;
  originalHeadline: string;
}

export interface AdminArticle extends KidArticle {
  sourceId: string;
  originalHeadline: string;
}

export function toAdminArticle(row: AdminArticleRow): AdminArticle {
  const { sourceId, originalHeadline, ...rest } = row;
  return { ...toKidArticle(rest), sourceId, originalHeadline };
}

export const SORTABLE_FIELDS = ['createdAt', 'publishedAt', 'readingMinutes', 'ageTarget'] as const;
export type SortField = (typeof SORTABLE_FIELDS)[number];

/** A fully validated query. Parsing and validation happen in the route. */
export interface ArticleQuery {
  status?: ArticleStatus;
  categories?: string[];
  safeties?: Safety[];
  sourceIds?: string[];
  ageTargets?: number[];
  search?: string;
  createdFrom?: string;
  createdTo?: string;
  publishedFrom?: string;
  publishedTo?: string;
  sort?: SortField;
  order?: 'asc' | 'desc';
}

/** The content fields a regeneration or an edit may replace. */
export type ArticleContent = Pick<
  KidArticle,
  | 'kidHeadline' | 'summary' | 'whatHappened' | 'whyItMatters' | 'vocab'
  | 'thinkAbout' | 'feelingNote' | 'safety' | 'contentWarnings'
  | 'category' | 'readingMinutes' | 'ageTarget'
>;

/** Written once; every INSERT and the admin SELECT derive from it. */
const COLUMNS = [
  'id', 'originalId', 'ageTarget', 'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'vocab', 'thinkAbout', 'feelingNote', 'safety', 'contentWarnings', 'category', 'readingMinutes',
  'sourceName', 'sourceUrl', 'status', 'rejectReason', 'editedByHuman', 'createdAt', 'publishedAt',
] as const;

const INSERT_SQL = `INSERT INTO kid_articles (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`;

/** kid_articles joined to its raw article, which the queue always needs. */
const ADMIN_SELECT = `
  SELECT k.*, r.sourceId AS sourceId, r.headline AS originalHeadline
  FROM kid_articles k JOIN raw_articles r ON r.id = k.originalId`;

export interface ArticleRepository {
  insert(article: KidArticle): void;
  findById(id: string): KidArticle | undefined;
  findAdminById(id: string): AdminArticle | undefined;
  /** Status + safety only — enough to decide whether an action is allowed. */
  findState(id: string): { id: string; status: ArticleStatus; safety: Safety } | undefined;
  listPublic(status?: ArticleStatus): KidArticle[];
  query(query: ArticleQuery): AdminArticle[];
  countsByStatus(): Record<ArticleStatus, number> & { total: number };
  distinctCategories(): string[];
  distinctAgeTargets(): number[];
  publish(id: string, at: string): void;
  reject(id: string, reason: string | null): void;
  returnToQueue(id: string): void;
  remove(id: string): void;
  /** Applies a partial content update and marks the row human-edited. */
  applyEdit(id: string, changes: Partial<ArticleContent>): void;
  /** Replaces content from a regeneration; clears the human-edited flag. */
  applyRegeneration(id: string, content: ArticleContent): void;
}

export function createArticleRepository(db: Database): ArticleRepository {
  const statements = {
    insert: db.prepare(INSERT_SQL),
    byId: db.prepare(`SELECT * FROM kid_articles WHERE id = ?`),
    adminById: db.prepare(`${ADMIN_SELECT} WHERE k.id = ?`),
    state: db.prepare(`SELECT id, status, safety FROM kid_articles WHERE id = ?`),
    allPublic: db.prepare(`SELECT * FROM kid_articles ORDER BY createdAt DESC`),
    byStatus: db.prepare(`SELECT * FROM kid_articles WHERE status = ? ORDER BY createdAt DESC`),
    counts: db.prepare(`SELECT status, COUNT(*) AS n FROM kid_articles GROUP BY status`),
    categories: db.prepare(`SELECT DISTINCT category FROM kid_articles ORDER BY category`),
    ages: db.prepare(`SELECT DISTINCT ageTarget FROM kid_articles ORDER BY ageTarget`),
    publish: db.prepare(`UPDATE kid_articles SET status='published', publishedAt=@at WHERE id=@id`),
    reject: db.prepare(`UPDATE kid_articles SET status='rejected', rejectReason=@reason WHERE id=@id`),
    requeue: db.prepare(
      `UPDATE kid_articles SET status='pending_review', publishedAt=NULL, rejectReason=NULL WHERE id=@id`,
    ),
    remove: db.prepare(`DELETE FROM kid_articles WHERE id = ?`),
  };

  /** Marshal only the content fields that were supplied. */
  function contentParams(changes: Partial<ArticleContent>): {
    sets: string[];
    params: Record<string, string | number | null>;
  } {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = {};

    const put = (column: string, value: string | number | null) => {
      sets.push(`${column} = @${column}`);
      params[column] = value;
    };

    for (const key of ['kidHeadline','summary','whatHappened','whyItMatters','thinkAbout','category'] as const) {
      if (changes[key] !== undefined) put(key, changes[key] as string);
    }
    if (changes.feelingNote !== undefined) put('feelingNote', changes.feelingNote);
    if (changes.safety !== undefined) put('safety', changes.safety);
    if (changes.readingMinutes !== undefined) put('readingMinutes', changes.readingMinutes);
    if (changes.ageTarget !== undefined) put('ageTarget', changes.ageTarget);
    if (changes.vocab !== undefined) put('vocab', JSON.stringify(changes.vocab));
    if (changes.contentWarnings !== undefined) {
      put('contentWarnings',
        changes.contentWarnings && changes.contentWarnings.length > 0
          ? JSON.stringify(changes.contentWarnings)
          : null);
    }

    return { sets, params };
  }

  return {
    insert(article) {
      statements.insert.run(toKidArticleRow(article));
    },

    findById(id) {
      const row = statements.byId.get(id) as KidArticleRow | undefined;
      return row ? toKidArticle(row) : undefined;
    },

    findAdminById(id) {
      const row = statements.adminById.get(id) as AdminArticleRow | undefined;
      return row ? toAdminArticle(row) : undefined;
    },

    findState(id) {
      return statements.state.get(id) as
        | { id: string; status: ArticleStatus; safety: Safety }
        | undefined;
    },

    listPublic(status) {
      const rows = (status ? statements.byStatus.all(status) : statements.allPublic.all()) as KidArticleRow[];
      return rows.map(toKidArticle);
    },

    query(query) {
      const where: string[] = [];
      const params: Record<string, string | number> = {};

      const inClause = (column: string, prefix: string, values: (string | number)[]) => {
        if (values.length === 0) return;
        where.push(`${column} IN (${values.map((_, i) => `@${prefix}${i}`).join(', ')})`);
        values.forEach((value, i) => (params[`${prefix}${i}`] = value));
      };

      if (query.status) {
        where.push('k.status = @status');
        params.status = query.status;
      }
      inClause('k.category', 'cat', query.categories ?? []);
      inClause('k.safety', 'saf', query.safeties ?? []);
      inClause('r.sourceId', 'src', query.sourceIds ?? []);
      inClause('k.ageTarget', 'age', query.ageTargets ?? []);

      if (query.search) {
        // §4.2: kid headline, summary, and the ORIGINAL headline.
        where.push('(k.kidHeadline LIKE @q OR k.summary LIKE @q OR r.headline LIKE @q)');
        // Escape LIKE wildcards so a literal % or _ searches for itself.
        params.q = `%${query.search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
      }

      for (const [key, clause] of [
        ['createdFrom', 'k.createdAt >='],
        ['createdTo', 'k.createdAt <='],
        ['publishedFrom', 'k.publishedAt >='],
        ['publishedTo', 'k.publishedAt <='],
      ] as const) {
        const value = query[key];
        if (value) {
          where.push(`${clause} @${key}`);
          params[key] = value;
        }
      }

      // `sort` is validated against SORTABLE_FIELDS by the caller, so it is
      // safe to interpolate; nothing else here ever is.
      const sort: SortField = query.sort ?? 'createdAt';
      const order = query.order === 'asc' ? 'ASC' : 'DESC';
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const rows = db
        .prepare(`${ADMIN_SELECT} ${clause} ORDER BY k.${sort} ${order}, k.id ASC`)
        .all(params) as AdminArticleRow[];

      return rows.map(toAdminArticle);
    },

    countsByStatus() {
      const counts = { pending_review: 0, published: 0, rejected: 0, total: 0 };
      for (const row of statements.counts.all() as { status: ArticleStatus; n: number }[]) {
        counts[row.status] = row.n;
        counts.total += row.n;
      }
      return counts;
    },

    distinctCategories: () => statements.categories.pluck().all() as string[],
    distinctAgeTargets: () => statements.ages.pluck().all() as number[],

    publish: (id, at) => void statements.publish.run({ id, at }),
    reject: (id, reason) => void statements.reject.run({ id, reason }),
    returnToQueue: (id) => void statements.requeue.run({ id }),
    remove: (id) => void statements.remove.run(id),

    applyEdit(id, changes) {
      const { sets, params } = contentParams(changes);
      // §4.2: "Edits mark the article as edited_by_human."
      sets.push('editedByHuman = 1');
      db.prepare(`UPDATE kid_articles SET ${sets.join(', ')} WHERE id = @id`).run({ ...params, id });
    },

    applyRegeneration(id, content) {
      const { sets, params } = contentParams(content);
      // Machine-generated again, so the human-edited flag no longer holds.
      sets.push('editedByHuman = 0');
      db.prepare(`UPDATE kid_articles SET ${sets.join(', ')} WHERE id = @id`).run({ ...params, id });
    },
  };
}
