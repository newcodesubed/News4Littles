/** Editor portal routes — PRD §4.3. Thin: all the work is in the service. */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../../core/errors.js';
import {
  createManualArticle, simplifySubmission,
  type ContentOverrides, type Submission,
} from '../../services/submitArticle.js';
import {
  requireAgeTarget, requireInt, requireOneOf, requireString, requireVocab,
} from '../../http/validation.js';

const SAVEABLE_STATUSES = ['pending_review', 'published'] as const;

function readSubmission(body: Record<string, unknown>): Submission {
  return {
    headline: requireString(body.headline, 'Original headline'),
    sourceName: requireString(body.sourceName, 'Source name'),
    sourceUrl: requireString(body.sourceUrl, 'Source URL'),
    body: requireString(body.body, 'Article text'),
    category: requireString(body.category, 'Category'),
    ageTarget: requireAgeTarget(body.ageTarget),
  };
}

/**
 * Only text comes from the client. `safety` and `contentWarnings` are
 * deliberately absent: the guard decides those (§4.3 requirement 5).
 */
function readOverrides(body: Record<string, unknown>): ContentOverrides {
  const overrides: ContentOverrides = {};

  for (const field of ['kidHeadline','summary','whatHappened','whyItMatters','thinkAbout'] as const) {
    if (typeof body[field] === 'string') overrides[field] = requireString(body[field], field);
  }
  if (body.readingMinutes !== undefined) {
    overrides.readingMinutes = requireInt(body.readingMinutes, 'readingMinutes', { min: 1 });
  }
  if (body.vocab !== undefined) overrides.vocab = requireVocab(body.vocab);

  return overrides;
}

export function createSubmitRouter(db: Database): Router {
  const router = Router();

  /** §4.3 "Simplify with AI" — preview; nothing is written. */
  router.post('/simplify', async (req, res) => {
    const submission = readSubmission((req.body ?? {}) as Record<string, unknown>);
    res.json(await simplifySubmission(db, submission));
  });

  /** §4.3 "Send for review" / "Publish". */
  router.post('/articles', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = requireOneOf(body.status ?? 'pending_review', SAVEABLE_STATUSES, 'status');

    const submission = readSubmission(body);
    const overrides = readOverrides(body);

    res.status(201).json(await createManualArticle(db, submission, overrides, status));
  });

  return router;
}

