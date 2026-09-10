/**
 * Every piece of SQL that touches kid_articles.
 *
 * Before this existed the 21-column INSERT was written out three times (the
 * scraper, the seed script and the editor portal) and the JSON/boolean
 * marshalling four times. Callers now pass a KidArticle and never see a column
 * name.
 */
import type { Database } from 'better-sqlite3';
import { strictestSafety } from '../../pipeline/guard.js';
import {
  toKidArticle, toKidArticleRow,
  type ArticleStatus, type KidArticle, type KidArticleRow, type Safety,
} from '../../core/article.js';

/** Columns the review queue needs that do not live on kid_articles. */
export interface AdminArticleRow extends KidArticleRow {
  sourceId: string;
  originalHeadline: string;
  approvedBy: string | null;
}

/**
 * `approvedBy` lives here rather than on KidArticle on purpose: only the review
 * queue needs to know a story was published by the auto-mode judge, and a
 * reader has no business seeing it. Keeping it off KidArticle also keeps the
 * INSERT column list — and every caller that builds one — untouched.
 */
export interface AdminArticle extends KidArticle {
  sourceId: string;
  originalHeadline: string;
  /** 'auto' when the auto-mode judge published it; NULL whenever a person did. */
  approvedBy: string | null;
}

/**
 * One story as the review queue shows it: every age version, plus the
 * story-level facts an editor decides on.
 *
 * `safety` is the STRICTEST across versions (§6). A story that is skip-young at
 * age 5 must never present as calm because age 14 is — the editor is about to
 * approve all ten at once.
 */
export interface AdminStory {
  originalId: string;
  /** Every version, ascending by ageTarget. Never empty. */
  versions: AdminArticle[];
  safety: Safety;
  /** 'auto' when the judge published it, NULL when a person did. */
  approvedBy: string | null;
  /** Shared by every version: publish, reject and delete are story-scoped. */
  status: ArticleStatus;
  /** The youngest version's headline, as the row's label. */
  kidHeadline: string;
  category: string;
  sourceId: string;
  originalHeadline: string;
  createdAt: string;
}

export function toAdminArticle(row: AdminArticleRow): AdminArticle {
  const { sourceId, originalHeadline, approvedBy, ...rest } = row;
  return { ...toKidArticle(rest), sourceId, originalHeadline, approvedBy: approvedBy ?? null };
}

export const SORTABLE_FIELDS = ['createdAt', 'publishedAt', 'readingMinutes', 'ageTarget'] as const;
export type SortField = (typeof SORTABLE_FIELDS)[number];

/** A fully validated query. Parsing and validation happen in the route. */
export interface ArticleQuery {
  status?: ArticleStatus;
  categories?: string[];
  safeties?: Safety[];
  sourceIds?: string[];
  /** Restrict to specific stories, by their raw article's id. */
  originalIds?: string[];
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
  /**
   * §6: the published version written FOR this reading age. Exact match only —
   * a story exists in one version per age (5-14), so a missing age means the
   * story was never simplified for this reader, and showing them an age-12
   * rewrite instead is worse than showing nothing.
   */
  listPublishedForAge(age: number): KidArticle[];
  findPublishedForAge(id: string, age: number): KidArticle | undefined;
  findAdminById(id: string): AdminArticle | undefined;
  /** Status + safety only — enough to decide whether an action is allowed. */
  findState(id: string): { id: string; status: ArticleStatus; safety: Safety } | undefined;
  query(query: ArticleQuery): AdminArticle[];
  /** §5: one row per story, for the grouped review queue. */
  queryStories(query: ArticleQuery): AdminStory[];
  /** Status plus the story's STRICTEST safety, for deciding an action. */
  findStoryState(id: string): { originalId: string; status: ArticleStatus; safety: Safety } | undefined;
  countsByStatus(): Record<ArticleStatus, number> & { total: number };
  distinctCategories(): string[];
  distinctAgeTargets(): number[];
  /**
   * §5: publish, reject, unpublish and delete are STORY-scoped — an editor
   * approves a story, and every age version has to move with it. Each takes any
   * one version's id and resolves it to the story.
   */
  publishStory(id: string, at: string, approvedBy?: 'auto' | null): void;
  /** §5: one story by its raw article's id, or undefined. */
  findStory(originalId: string): AdminStory | undefined;
  rejectStory(id: string, reason: string | null): void;
  returnStoryToQueue(id: string): void;
  removeStory(id: string): void;
  /** Applies a partial content update and marks the row human-edited. */
  applyEdit(id: string, changes: Partial<ArticleContent>): void;
  /** Replaces content from a regeneration; clears the human-edited flag. */
  applyRegeneration(id: string, content: ArticleContent): void;
}

export function createArticleRepository(db: Database): ArticleRepository {
  const statements = {
    insert: db.prepare(INSERT_SQL),
    adminById: db.prepare(`${ADMIN_SELECT} WHERE k.id = ?`),
    state: db.prepare(`SELECT id, status, safety FROM kid_articles WHERE id = ?`),
    // §6: the version written for this age. One version per age per story, so
    // this is one row per story with no grouping needed.
    publishedForAge: db.prepare(
      `SELECT * FROM kid_articles
       WHERE status = 'published' AND ageTarget = @age
       ORDER BY createdAt DESC`,
    ),
    // The same, inside ONE story resolved from any of its version ids, so the
    // slider keeps working on a story page.
    publishedForAgeById: db.prepare(
      `SELECT * FROM kid_articles
       WHERE status = 'published' AND ageTarget = @age
         AND originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`,
    ),
    versionsForStories: (count: number) =>
      db.prepare(
        `${ADMIN_SELECT} WHERE k.originalId IN (${Array(count).fill('?').join(', ')})
         ORDER BY k.ageTarget`,
      ),
    storyCounts: db.prepare(
      `SELECT status, COUNT(DISTINCT originalId) AS n FROM kid_articles GROUP BY status`,
    ),
    storyStateFor: db.prepare(
      `SELECT originalId, status, safety FROM kid_articles
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = ?)`,
    ),
    categories: db.prepare(`SELECT DISTINCT category FROM kid_articles ORDER BY category`),
    ages: db.prepare(`SELECT DISTINCT ageTarget FROM kid_articles ORDER BY ageTarget`),
    // The subselect resolves the story from any one of its versions.
    publishStory: db.prepare(
      `UPDATE kid_articles SET status='published', publishedAt=@at, approvedBy=@approvedBy
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`,
    ),
    rejectStory: db.prepare(
      `UPDATE kid_articles SET status='rejected', rejectReason=@reason
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`,
    ),
    requeueStory: db.prepare(
      `UPDATE kid_articles SET status='pending_review', publishedAt=NULL, rejectReason=NULL
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`,
    ),
    removeStory: db.prepare(
      `DELETE FROM kid_articles
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = ?)`,
    ),
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

  const repository: ArticleRepository = {
    insert(article) {
      statements.insert.run(toKidArticleRow(article));
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

    listPublishedForAge(age) {
      return (statements.publishedForAge.all({ age }) as KidArticleRow[]).map(toKidArticle);
    },

    findPublishedForAge(id, age) {
      const row = statements.publishedForAgeById.get({ id, age }) as KidArticleRow | undefined;
      return row ? toKidArticle(row) : undefined;
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
      inClause('k.originalId', 'orig', query.originalIds ?? []);
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
      // DISTINCT originalId: ten age versions are ONE story to review, and a
      // Pending badge reading 100 for ten stories is useless.
      const counts = { pending_review: 0, published: 0, rejected: 0, total: 0 };
      for (const row of statements.storyCounts.all() as { status: ArticleStatus; n: number }[]) {
        counts[row.status] = row.n;
        counts.total += row.n;
      }
      return counts;
    },

    queryStories(query) {
      // The filter runs over VERSIONS, reusing the one filter builder, so the
      // flat and grouped queues can never disagree about what matches.
      const matched = repository.query(query);
      if (matched.length === 0) return [];

      // Distinct originalIds in the order query() returned them, so the
      // caller's sort still decides the order stories appear in.
      const order: string[] = [];
      const seen = new Set<string>();
      for (const version of matched) {
        if (seen.has(version.originalId)) continue;
        seen.add(version.originalId);
        order.push(version.originalId);
      }

      // Every version of those stories, not just the ones that matched: an
      // editor approving a story is approving all of it.
      const rows = statements.versionsForStories(order.length).all(...order) as AdminArticleRow[];

      const byStory = new Map<string, AdminArticle[]>();
      for (const row of rows) {
        const version = toAdminArticle(row);
        const list = byStory.get(version.originalId);
        if (list) list.push(version);
        else byStory.set(version.originalId, [version]);
      }

      return order.flatMap((originalId) => {
        const versions = byStory.get(originalId);
        if (!versions || versions.length === 0) return [];

        const youngest = versions[0];
        return [{
          originalId,
          versions,
          safety: strictestSafety(versions.map((v) => v.safety)),
          status: youngest.status,
          approvedBy: youngest.approvedBy,
          kidHeadline: youngest.kidHeadline,
          category: youngest.category,
          sourceId: youngest.sourceId,
          originalHeadline: youngest.originalHeadline,
          createdAt: youngest.createdAt,
        }];
      });
    },

    findStory(originalId) {
      // queryStories already collapses versions and computes the strictest
      // safety; this is that, for one story, by its raw article's id.
      const [story] = repository.queryStories({ originalIds: [originalId] });
      return story;
    },

    findStoryState(id) {
      const rows = statements.storyStateFor.all(id) as
        { originalId: string; status: ArticleStatus; safety: Safety }[];
      if (rows.length === 0) return undefined;

      return {
        originalId: rows[0].originalId,
        status: rows[0].status,
        // The strictest, so a bulk approve cannot slip a skip-young version
        // through because the selected version happened to be calm.
        safety: strictestSafety(rows.map((row) => row.safety)),
      };
    },

    distinctCategories: () => statements.categories.pluck().all() as string[],
    distinctAgeTargets: () => statements.ages.pluck().all() as number[],

    // approvedBy defaults to NULL, so every existing caller keeps recording
    // "a person did this" without having to say so.
    publishStory: (id, at, approvedBy = null) =>
      void statements.publishStory.run({ id, at, approvedBy }),
    rejectStory: (id, reason) => void statements.rejectStory.run({ id, reason }),
    returnStoryToQueue: (id) => void statements.requeueStory.run({ id }),
    removeStory: (id) => void statements.removeStory.run(id),

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

  return repository;
}
