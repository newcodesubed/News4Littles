/** Row actions on one article: publish / reject / re-review / edit / regenerate / delete (§4.2). */
import { Router } from 'express';
import type { Response } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import {
  createArticleRepository, type ArticleContent,
} from '../../db/repositories/articleRepository.js';
import { regenerateArticle } from '../../services/regenerateArticle.js';
import {
  optionalString, requireAgeTarget, requireInt, requireSafety, requireString,
  requireStringListOrNull, requireVocab,
} from '../../http/validation.js';

/** Read the editable subset of §4.2's field list off a request body. */
function readContentChanges(body: Record<string, unknown>): Partial<ArticleContent> {
  const changes: Partial<ArticleContent> = {};

  for (const field of ['kidHeadline','summary','whatHappened','whyItMatters','thinkAbout','category'] as const) {
    if (body[field] !== undefined) changes[field] = requireString(body[field], field);
  }
  if (body.feelingNote !== undefined) changes.feelingNote = optionalString(body.feelingNote);
  if (body.safety !== undefined) changes.safety = requireSafety(body.safety);
  if (body.readingMinutes !== undefined) {
    changes.readingMinutes = requireInt(body.readingMinutes, 'readingMinutes', { min: 1 });
  }
  if (body.ageTarget !== undefined) changes.ageTarget = requireAgeTarget(body.ageTarget, 'ageTarget');
  if (body.vocab !== undefined) changes.vocab = requireVocab(body.vocab);
  if (body.contentWarnings !== undefined) {
    changes.contentWarnings = requireStringListOrNull(body.contentWarnings, 'contentWarnings');
  }

  return changes;
}

export function createArticleActionsRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);

  /** Throws 404 rather than letting a route update a row that isn't there. */
  const requireArticle = (id: string) => {
    const state = articles.findState(id);
    if (!state) throw NotFoundError.of('article', id);
    return state;
  };

  const respond = (res: Response, id: string) => res.json(articles.findAdminById(id));

  router.patch('/articles/:id/publish', (req, res) => {
    requireArticle(req.params.id);
    articles.publish(req.params.id, new Date().toISOString());
    respond(res, req.params.id);
  });

  router.patch('/articles/:id/reject', (req, res) => {
    requireArticle(req.params.id);
    // §4.2: the reason is optional free text, stored on the article.
    articles.reject(req.params.id, optionalString((req.body ?? {}).reason));
    respond(res, req.params.id);
  });

  router.patch('/articles/:id/unpublish', (req, res) => {
    requireArticle(req.params.id);
    // §4.2: "move published/rejected items back to pending_review".
    articles.returnToQueue(req.params.id);
    respond(res, req.params.id);
  });

  /** §4.2 Edit — every kid-facing field; saving marks the article human-edited. */
  router.patch('/articles/:id', (req, res) => {
    requireArticle(req.params.id);

    const changes = readContentChanges((req.body ?? {}) as Record<string, unknown>);
    if (Object.keys(changes).length === 0) throw new BadRequestError('No editable fields supplied.');

    articles.applyEdit(req.params.id, changes);
    respond(res, req.params.id);
  });

  /** §4.2 Regenerate: preview only. Nothing is written here. */
  router.post('/articles/:id/regenerate', (req, res) => {
    res.json(regenerateArticle(db, req.params.id));
  });

  router.post('/articles/:id/regenerate/apply', (req, res) => {
    const { generated } = regenerateArticle(db, req.params.id);
    articles.applyRegeneration(req.params.id, generated);
    respond(res, req.params.id);
  });

  /** §4.2: delete is only ever allowed on a non-published article. */
  router.delete('/articles/:id', (req, res) => {
    const { status } = requireArticle(req.params.id);
    if (status === 'published') {
      throw new ConflictError('Published articles cannot be deleted. Unpublish it first, then delete.');
    }
    articles.remove(req.params.id);
    res.json({ deleted: req.params.id });
  });

  return router;
}
