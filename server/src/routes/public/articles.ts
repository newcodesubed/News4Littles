/**
 * Public article routes (PRD §3). Read-only: no auth, no mutations.
 *
 * One entry per story, at the reader's reading age (§3.6, §6): a story exists
 * in one version per reading band (AGE_BANDS), and `?age=N` picks the version
 * written for the band N falls in.
 *
 * Published stories ONLY, and not because the caller asked nicely — the
 * repository methods used here hardcode the status. This endpoint is what a
 * child's browser reaches, and §2.2 promises a human read every word first, so
 * a `status` query parameter used to make that promise depend on the caller.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { NotFoundError } from '../../core/errors.js';
import { createArticleRepository } from '../../db/repositories/articleRepository.js';
import { createAgeTargetReader } from './ageTarget.js';

export function createArticlesRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);
  const readAgeTarget = createAgeTargetReader(db);

  /**
   * GET /api/articles[?age=N] -> PublicArticle[], newest first, published only.
   * One entry per story: the version written for N's reading band.
   * A bare array, so the frontend can map it directly.
   */
  router.get('/articles', (req, res) => {
    res.json(articles.listPublishedForAge(readAgeTarget(req.query.age)));
  });

  /**
   * 404, not 403, for an unpublished story: a 403 would confirm it exists and
   * let someone enumerate what is sitting unreviewed in the queue.
   *
   * The id names one version; the reader gets that STORY at their age, so the
   * slider keeps working after they have opened something.
   */
  router.get('/articles/:id', (req, res) => {
    const article = articles.findPublishedForAge(req.params.id, readAgeTarget(req.query.age));
    if (!article) throw NotFoundError.of('article', req.params.id);
    res.json(article);
  });

  return router;
}
