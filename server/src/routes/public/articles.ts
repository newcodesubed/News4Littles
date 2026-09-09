/**
 * Public article routes (PRD §3). Read-only: no auth, no mutations.
 *
 * One entry per story, at the reader's reading age (§3.6, §6): a story exists
 * in one version per age, and `?age=N` picks the version for N or the nearest
 * published one.
 *
 * Published stories ONLY, and not because the caller asked nicely — the
 * repository methods used here hardcode the status. This endpoint is what a
 * child's browser reaches, and §2.2 promises a human read every word first, so
 * a `status` query parameter used to make that promise depend on the caller.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { MAX_AGE, MIN_AGE } from '../../core/article.js';
import { NotFoundError } from '../../core/errors.js';
import { createArticleRepository } from '../../db/repositories/articleRepository.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';

export function createArticlesRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);
  const settings = createSettingsRepository(db);

  /**
   * The reader's age, or the configured default.
   *
   * An absent, non-numeric or out-of-range value falls back rather than
   * erroring: this is the read path a child's browser hits, and answering with
   * the default beats a 400 because a query string was odd. Bound as a
   * parameter by the repository, never interpolated.
   */
  const readAge = (raw: unknown): number => {
    const age = Number(raw);
    const usable = Number.isInteger(age) && age >= MIN_AGE && age <= MAX_AGE;
    return usable ? age : settings.getAppSettings().defaultAge;
  };

  /**
   * GET /api/articles[?age=N] -> PublicArticle[], newest first, published only.
   * One entry per story: the version for age N, or the nearest published one.
   * A bare array, so the frontend can map it directly.
   */
  router.get('/articles', (req, res) => {
    res.json(articles.listPublishedForAge(readAge(req.query.age)));
  });

  /**
   * 404, not 403, for an unpublished story: a 403 would confirm it exists and
   * let someone enumerate what is sitting unreviewed in the queue.
   *
   * The id names one version; the reader gets that STORY at their age, so the
   * slider keeps working after they have opened something.
   */
  router.get('/articles/:id', (req, res) => {
    const article = articles.findPublishedForAge(req.params.id, readAge(req.query.age));
    if (!article) throw NotFoundError.of('article', req.params.id);
    res.json(article);
  });

  return router;
}
