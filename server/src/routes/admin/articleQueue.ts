/** Review-queue reads: the filtered list, tab counts and filter options (§4.2). */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { ARTICLE_STATUSES, FLAGGED_SAFETY, SAFETY_VALUES } from '../../core/article.js';
import {
  createArticleRepository, SORTABLE_FIELDS, type ArticleQuery,
} from '../../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../../db/repositories/rawArticleRepository.js';
import { createSourceRepository } from '../../db/repositories/sourceRepository.js';
import {
  parseBool, parseList, requireInt, requireOneOf, requireSafetyList, requireStatus,
} from '../../http/validation.js';

/** A trimmed query-string value, or undefined. */
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export function createArticleQueueRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);
  const rawArticles = createRawArticleRepository(db);
  const sources = createSourceRepository(db);

  /** §4.2: a count badge per status tab, plus the backlog tab's own. */
  router.get('/articles/counts', (_req, res) => {
    res.json({ ...articles.countsByStatus(), waiting: rawArticles.countWaiting() });
  });

  /**
   * Options for the filter bar. Not itself in §4.2, but its category and
   * source dropdowns cannot be populated without it.
   */
  router.get('/articles/filters', (_req, res) => {
    res.json({
      categories: articles.distinctCategories(),
      sources: sources.listWithCounts().map(({ id, name }) => ({ id, name })),
      ageTargets: articles.distinctAgeTargets(),
      safety: SAFETY_VALUES,
      statuses: ARTICLE_STATUSES,
      sortFields: SORTABLE_FIELDS,
    });
  });

  /** §4.2: every filter combines with the active status tab. */
  router.get('/articles', (req, res) => {
    const { status, category, safety, source, ageTarget, q, sort, order } = req.query;

    // The "flagged only" shortcut replaces any explicit safety selection.
    const safeties = parseBool(req.query.flagged)
      ? [...FLAGGED_SAFETY]
      : requireSafetyList(parseList(safety));

    const query: ArticleQuery = {
      status: status === undefined ? undefined : requireStatus(status),
      categories: parseList(category),
      safeties,
      sourceIds: parseList(source),
      ageTargets: parseList(ageTarget).map((value) => requireInt(value, 'ageTarget')),
      search: text(q),
      createdFrom: text(req.query.createdFrom),
      createdTo: text(req.query.createdTo),
      publishedFrom: text(req.query.publishedFrom),
      publishedTo: text(req.query.publishedTo),
      sort: sort === undefined ? 'createdAt' : requireOneOf(sort, SORTABLE_FIELDS, 'sort'),
      order: String(order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    };

    const results = articles.query(query);
    res.json({ articles: results, total: results.length });
  });

  return router;
}
