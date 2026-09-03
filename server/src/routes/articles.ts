/**
 * Public article routes (PRD §3). Read-only for now — no admin auth, no
 * mutations, no scraping. Enough to build the UI against.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import {
  ARTICLE_STATUSES,
  isArticleStatus,
  toKidArticle,
  type KidArticleRow,
} from '../db/mappers.js';

export function createArticlesRouter(db: Database): Router {
  const router = Router();

  // Newest first, per §4.2 ("newest first by default").
  const selectAll = db.prepare<[], KidArticleRow>(
    `SELECT * FROM kid_articles ORDER BY createdAt DESC`,
  );
  const selectByStatus = db.prepare<[string], KidArticleRow>(
    `SELECT * FROM kid_articles WHERE status = ? ORDER BY createdAt DESC`,
  );
  const selectById = db.prepare<[string], KidArticleRow>(
    `SELECT * FROM kid_articles WHERE id = ?`,
  );

  /**
   * GET /api/articles
   * GET /api/articles?status=published
   *
   * -> 200 KidArticle[]   (newest first)
   * -> 400 { error }      unknown status value
   */
  router.get('/articles', (req, res) => {
    const status = req.query.status;

    if (status === undefined) {
      res.json(selectAll.all().map(toKidArticle));
      return;
    }

    if (typeof status !== 'string' || !isArticleStatus(status)) {
      res.status(400).json({
        error: `Unknown status '${String(status)}'. Expected one of: ${ARTICLE_STATUSES.join(', ')}.`,
      });
      return;
    }

    res.json(selectByStatus.all(status).map(toKidArticle));
  });

  /**
   * GET /api/articles/:id
   *
   * -> 200 KidArticle
   * -> 404 { error }
   */
  router.get('/articles/:id', (req, res) => {
    const row = selectById.get(req.params.id);

    if (!row) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }

    res.json(toKidArticle(row));
  });

  return router;
}
