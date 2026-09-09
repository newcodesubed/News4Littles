/**
 * The raw-article backlog — articles a scrape stored but did not spend its
 * simplification budget on — and simplifying them on demand.
 *
 * A single article is one model call, but an editor can select fifteen, which
 * is a minute or more of sequential calls. So POST starts a background job and
 * the client polls, the same shape as §4.4's "Run now".
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../../core/errors.js';
import { createRawArticleRepository } from '../../db/repositories/rawArticleRepository.js';
import { getSimplifyJob, startSimplifyJob } from '../../services/simplifyService.js';

/** A ceiling, so one request cannot ask for the entire table. */
const MAX_LIST = 200;
const DEFAULT_LIST = 50;

export function createRawArticlesRouter(db: Database): Router {
  const router = Router();
  const raws = createRawArticleRepository(db);

  const jobResponse = () => {
    const job = getSimplifyJob();
    return { running: job?.running ?? false, job };
  };

  /** §7.6: recent raw articles for the sandbox's test-article dropdown. */
  router.get('/raw-articles', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
    res.json(
      db
        .prepare(
          `SELECT r.id, r.headline, r.sourceName, r.topic, r.publishedAt, r.fetchedAt,
                  LENGTH(r.body) AS bodyLength
           FROM raw_articles r ORDER BY r.fetchedAt DESC LIMIT ?`,
        )
        .all(limit),
    );
  });

  /** The backlog: stored, never simplified. Newest first, undated last. */
  router.get('/raw-articles/waiting', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? DEFAULT_LIST) || DEFAULT_LIST, MAX_LIST);
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';

    res.json({
      articles: raws.listWaiting({ sourceId: source || undefined, limit }),
      // The unfiltered total, so the tab badge and the list agree.
      total: raws.countWaiting(),
    });
  });

  router.get('/raw-articles/simplify/status', (_req, res) => {
    res.json(jobResponse());
  });

  /** Returns straight away; poll /raw-articles/simplify/status. */
  router.post('/raw-articles/simplify', (req, res) => {
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
      throw new BadRequestError('ids must be a non-empty array of raw article ids.');
    }

    startSimplifyJob(db, ids as string[]);
    res.status(202).json(jobResponse());
  });

  return router;
}
