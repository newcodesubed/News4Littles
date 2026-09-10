/**
 * Row actions on one story: publish / reject / re-review / edit / regenerate /
 * delete (§4.2).
 *
 * SCOPE (§5): a story is one raw article's ten age versions (§3.6), and an
 * editor approves the story. So publish, reject, unpublish, delete and
 * regenerate take any one version's id and apply to EVERY version of that
 * story. The URLs are unchanged from when a story had one version; the scope
 * is not.
 *
 * Edit is the exception and stays per-version, so one age's wording can be
 * fixed without touching the other nine. Regenerate previews every age but
 * applies only the ones an editor ticks, which is the same idea from the other
 * end: the machine offers all ten, the person chooses.
 */
import { Router } from 'express';
import type { Response } from 'express';
import type { Database } from 'better-sqlite3';
import { MAX_AGE, MIN_AGE } from '../../core/article.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import {
  createArticleRepository, type ArticleContent,
} from '../../db/repositories/articleRepository.js';
import {
  applyRegeneratedVersions, getRegenerateJob, resetRegenerateJob, startRegenerateJob,
} from '../../services/regenerateStory.js';
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

/** The ticked ages an apply request carries. */
function readAges(body: Record<string, unknown>): number[] {
  const { ages } = body;
  if (!Array.isArray(ages) || ages.length === 0) {
    throw new BadRequestError('ages must be a non-empty array of reading ages.');
  }
  return ages.map((age, index) => requireInt(age, `ages[${index}]`, { min: MIN_AGE, max: MAX_AGE }));
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

  /** The same envelope the simplify batch reports, for the same poller. */
  const jobResponse = () => {
    const job = getRegenerateJob();
    return { running: job?.running ?? false, job };
  };

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

  /**
   * §4.2 Regenerate — preview only, and story-scoped (§5).
   *
   * Ten versions is ten sequential model calls, so this returns straight away;
   * poll /articles/regenerate/status.
   */
  router.post('/articles/:id/regenerate', (req, res) => {
    requireStory(req.params.id);
    startRegenerateJob(db, req.params.id);
    res.status(202).json(jobResponse());
  });

  router.get('/articles/regenerate/status', (_req, res) => {
    res.json(jobResponse());
  });

  /** Writes the ticked ages from the held preview. No further model calls. */
  router.post('/articles/regenerate/apply', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const jobId = requireString(body.jobId, 'jobId');
    res.json(applyRegeneratedVersions(db, jobId, readAges(body)));
  });

  /** Discard: the editor closed the dialog, so stop holding the preview. */
  router.delete('/articles/regenerate', (_req, res) => {
    resetRegenerateJob();
    res.json({ discarded: true });
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
