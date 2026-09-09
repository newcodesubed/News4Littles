/**
 * Public article routes (PRD §3). Read-only: no auth, no mutations.
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

export function createArticlesRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);

  /**
   * GET /api/articles -> KidArticle[], newest first, published only.
   * A bare array, so the frontend can map it directly. Any `status` parameter
   * is ignored rather than rejected, so the existing frontend call still works.
   */
  router.get('/articles', (_req, res) => {
    res.json(articles.listPublished());
  });

  /**
   * 404, not 403, for an unpublished story: a 403 would confirm it exists and
   * let someone enumerate what is sitting unreviewed in the queue.
   */
  router.get('/articles/:id', (req, res) => {
    const article = articles.findPublishedById(req.params.id);
    if (!article) throw NotFoundError.of('article', req.params.id);
    res.json(article);
  });

  return router;
}
