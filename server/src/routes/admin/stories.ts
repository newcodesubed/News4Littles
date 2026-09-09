/**
 * The review queue, grouped by story (§5).
 *
 * A story is one raw article's ten age versions (§3.6). An editor reviews and
 * approves a story, not a version, so this endpoint returns one row per story
 * with every version nested — and a story-level safety verdict that is the
 * STRICTEST across those versions (§6), because approving the row approves all
 * of them.
 *
 * The flat `GET /articles` stays: §4.2's age filter and the filter dropdowns
 * need per-version rows.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { FLAGGED_SAFETY } from '../../core/article.js';
import {
  createArticleRepository, SORTABLE_FIELDS, type ArticleQuery,
} from '../../db/repositories/articleRepository.js';
import {
  parseBool, parseList, requireInt, requireOneOf, requireSafetyList, requireStatus,
} from '../../http/validation.js';

/** A trimmed query-string value, or undefined. */
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export function createStoriesRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);

  router.get('/stories', (req, res) => {
    const { status, category, safety, source, ageTarget, q, sort, order } = req.query;

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

    const stories = articles.queryStories(query);
    res.json({ stories, total: stories.length });
  });

  return router;
}
