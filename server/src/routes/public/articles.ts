/**
 * Public article routes (PRD §3). Read-only: no auth, no mutations.
 * Home and story pages show published stories only (§11.1).
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { NotFoundError } from '../../core/errors.js';
import { createArticleRepository } from '../../db/repositories/articleRepository.js';
import { requireStatus } from '../../http/validation.js';

export function createArticlesRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);

  /**
   * GET /api/articles[?status=…] -> KidArticle[], newest first.
   * A bare array, so the frontend can map it directly.
   */
  router.get('/articles', (req, res) => {
    const status = req.query.status === undefined ? undefined : requireStatus(req.query.status);
    res.json(articles.listPublic(status));
  });

  router.get('/articles/:id', (req, res) => {
    const article = articles.findById(req.params.id);
    if (!article) throw NotFoundError.of('article', req.params.id);
    res.json(article);
  });

  return router;
}
