/** Sources CRUD — PRD §4.4, §5.1. */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { createRawArticleRepository } from '../../db/repositories/rawArticleRepository.js';
import {
  createSourceRepository, TRUST_LEVELS, type TrustLevel,
} from '../../db/repositories/sourceRepository.js';
import { optionalString, parseBool, requireOneOf, requireString } from '../../http/validation.js';

/** Source ids appear in URLs and in the review-queue filter. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createSourcesRouter(db: Database): Router {
  const router = Router();
  const sources = createSourceRepository(db);
  const rawArticles = createRawArticleRepository(db);

  const requireSource = (id: string) => {
    const source = sources.findById(id);
    if (!source) throw NotFoundError.of('source', id);
    return source;
  };

  router.get('/sources', (_req, res) => {
    res.json(sources.listWithCounts());
  });

  router.post('/sources', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const id = String(body.id ?? '').trim().toLowerCase();
    if (!SLUG.test(id)) {
      throw new BadRequestError('id must be a slug: lowercase letters, digits and hyphens.');
    }
    if (sources.exists(id)) throw new ConflictError(`A source with id '${id}' already exists.`);

    const url = optionalString(body.url) ?? '';
    const enabled = parseBool(body.enabled);
    // A source cannot be scraped without a feed URL.
    if (enabled && !url) throw new BadRequestError('An enabled source needs a feed URL.');

    sources.insert(
      {
        id,
        name: requireString(body.name, 'name'),
        url,
        enabled,
        trustLevel: requireOneOf(body.trustLevel ?? 'high', TRUST_LEVELS, 'trustLevel'),
        parser: optionalString(body.parser),
      },
      new Date().toISOString(),
    );

    res.status(201).json({ id });
  });

  router.patch('/sources/:id', (req, res) => {
    const existing = requireSource(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const changes: Record<string, string | number | null> = {};

    if (body.name !== undefined) changes.name = requireString(body.name, 'name');
    if (body.url !== undefined) changes.url = optionalString(body.url) ?? '';
    if (body.parser !== undefined) changes.parser = optionalString(body.parser);
    if (body.trustLevel !== undefined) {
      changes.trustLevel = requireOneOf<TrustLevel>(body.trustLevel, TRUST_LEVELS, 'trustLevel');
    }
    if (body.enabled !== undefined) {
      const enabled = parseBool(body.enabled);
      const url = changes.url !== undefined ? String(changes.url) : existing.url;
      if (enabled && !url) throw new BadRequestError('An enabled source needs a feed URL.');
      changes.enabled = enabled ? 1 : 0;
    }

    if (Object.keys(changes).length === 0) throw new BadRequestError('No fields to update.');

    sources.update(req.params.id, changes, new Date().toISOString());
    res.json({ id: req.params.id });
  });

  /**
   * §5.1's lastFetchedAt / lastFetchedItemPublishedAt are scraper state, which
   * §4.4 calls "last-run results" — something to read. They are exposed
   * read-only, and this is the only legitimate edit: re-ingest from scratch.
   * Safer than a free-text timestamp, where a typo silently skips real stories.
   */
  router.post('/sources/:id/reset-cursor', (req, res) => {
    requireSource(req.params.id);
    sources.clearCursor(req.params.id, new Date().toISOString());
    res.json({ id: req.params.id, reset: true });
  });

  router.delete('/sources/:id', (req, res) => {
    requireSource(req.params.id);

    // The schema's ON DELETE RESTRICT protects ingested articles; surface it as
    // advice rather than a raw constraint error.
    const count = rawArticles.countForSource(req.params.id);
    if (count > 0) {
      throw new ConflictError(
        `'${req.params.id}' has ${count} ingested article(s), so it cannot be deleted. ` +
          'Disable it instead — its stories stay readable and it stops being scraped.',
      );
    }

    sources.remove(req.params.id);
    res.json({ deleted: req.params.id });
  });

  return router;
}
