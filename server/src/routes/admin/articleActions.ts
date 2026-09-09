/**
 * Row actions on one story: publish / reject / re-review / edit / regenerate /
 * delete (§4.2).
 *
 * SCOPE (§5): a story is one raw article's ten age versions (§3.6), and an
 * editor approves the story. So publish, reject, unpublish and delete take any
 * one version's id and apply to EVERY version of that story. The URLs are
 * unchanged from when a story had one version; the scope is not.
 *
 * Edit is the exception and stays per-version, so one age's wording can be
 * fixed without touching the other nine.
 */
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

  /** Throws 404 rather than letting a route update a story that isn't there. */
  const requireStory = (id: string) => {
    const state = articles.findStoryState(id);
    if (!state) throw NotFoundError.of('article', id);
    return state;
  };

  router.patch('/articles/:id/publish', (req, res) => {
    requireStory(req.params.id);
    articles.publishStory(req.params.id, new Date().toISOString());
    respond(res, req.params.id);
  });

  router.patch('/articles/:id/reject', (req, res) => {
    requireStory(req.params.id);
    // §4.2: the reason is optional free text, stored on every version.
    articles.rejectStory(req.params.id, optionalString((req.body ?? {}).reason));
    respond(res, req.params.id);
  });

  router.patch('/articles/:id/unpublish', (req, res) => {
    requireStory(req.params.id);
    // §4.2: "move published/rejected items back to pending_review".
    articles.returnStoryToQueue(req.params.id);
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
  router.post('/articles/:id/regenerate', async (req, res) => {
    res.json(await regenerateArticle(db, req.params.id));
  });

  router.post('/articles/:id/regenerate/apply', async (req, res) => {
    const { generated } = await regenerateArticle(db, req.params.id);
    articles.applyRegeneration(req.params.id, generated);
    respond(res, req.params.id);
  });

  /** §4.2: delete is only ever allowed on a non-published story. */
  router.delete('/articles/:id', (req, res) => {
    const { status } = requireStory(req.params.id);
    if (status === 'published') {
      throw new ConflictError('Published articles cannot be deleted. Unpublish it first, then delete.');
    }
    articles.removeStory(req.params.id);
    res.json({ deleted: req.params.id });
  });

  return router;
}
