/**
 * Admin review queue API — PRD §4.2.
 *
 * Every route here sits behind the Basic Auth middleware (§4.1). Nothing in
 * this file publishes anything without an explicit request.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import type { Database } from 'better-sqlite3';
import {
  ARTICLE_STATUSES,
  isArticleStatus,
  toKidArticle,
  type ArticleStatus,
  type KidArticleRow,
  type Safety,
  type VocabEntry,
} from '../db/mappers.js';
import { loadLocalPipelineConfig, simplifyLocally } from '../pipeline/localPipeline.js';

const SAFETY_VALUES: Safety[] = ['calm', 'adult-nearby', 'skip-young'];
/** §4.2: the "flagged only" shortcut selects both non-calm levels. */
const FLAGGED_SAFETY: Safety[] = ['adult-nearby', 'skip-young'];

const SORTABLE = ['createdAt', 'publishedAt', 'readingMinutes', 'ageTarget'] as const;
type SortField = (typeof SORTABLE)[number];

/** Accepts ?x=a&x=b and ?x=a,b interchangeably. */
function parseList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

class BadRequest extends Error {}

/** A kid_articles row plus the two admin-only extras the queue needs. */
interface AdminRow extends KidArticleRow {
  sourceId: string;
  originalHeadline: string;
}

function toAdminArticle(row: AdminRow) {
  const { sourceId, originalHeadline, ...rest } = row;
  return { ...toKidArticle(rest), sourceId, originalHeadline };
}

export function createAdminArticlesRouter(db: Database): Router {
  const router = Router();

  const findRow = db.prepare(`
    SELECT k.*, r.sourceId AS sourceId, r.headline AS originalHeadline
    FROM kid_articles k JOIN raw_articles r ON r.id = k.originalId
    WHERE k.id = ?`);

  const findStatus = db.prepare(`SELECT id, status, safety FROM kid_articles WHERE id = ?`);

  // ─── §4.2 tab counts ────────────────────────────────────────────────────
  router.get('/articles/counts', (_req, res) => {
    const rows = db
      .prepare(`SELECT status, COUNT(*) AS n FROM kid_articles GROUP BY status`)
      .all() as { status: ArticleStatus; n: number }[];

    const counts: Record<ArticleStatus, number> = {
      pending_review: 0,
      published: 0,
      rejected: 0,
    };
    for (const row of rows) counts[row.status] = row.n;

    res.json({ ...counts, total: rows.reduce((sum, row) => sum + row.n, 0) });
  });

  /**
   * Options for the filter bar. Not in the task list, but §4.2's category and
   * source dropdowns cannot be populated without it. Read-only; the sources
   * CRUD of §4.4 is a separate, later thing.
   */
  router.get('/articles/filters', (_req, res) => {
    res.json({
      categories: db
        .prepare(`SELECT DISTINCT category FROM kid_articles ORDER BY category`)
        .pluck()
        .all(),
      sources: db.prepare(`SELECT id, name FROM sources ORDER BY name`).all(),
      ageTargets: db
        .prepare(`SELECT DISTINCT ageTarget FROM kid_articles ORDER BY ageTarget`)
        .pluck()
        .all(),
      safety: SAFETY_VALUES,
      statuses: ARTICLE_STATUSES,
      sortFields: SORTABLE,
    });
  });

  // ─── §4.2 filtered, sorted list ─────────────────────────────────────────
  router.get('/articles', (req, res) => {
    try {
      const where: string[] = [];
      const params: Record<string, string | number> = {};

      const { status, category, safety, source, ageTarget, q, sort, order } = req.query;

      // Status tab (single).
      if (status !== undefined) {
        const value = String(status);
        if (!isArticleStatus(value)) {
          throw new BadRequest(`Unknown status '${value}'. Expected one of: ${ARTICLE_STATUSES.join(', ')}.`);
        }
        where.push('k.status = @status');
        params.status = value;
      }

      // Category (multi-select).
      const categories = parseList(category);
      if (categories.length > 0) {
        where.push(`k.category IN (${categories.map((_, i) => `@cat${i}`).join(', ')})`);
        categories.forEach((value, i) => (params[`cat${i}`] = value));
      }

      // Safety (multi), plus the "flagged only" shortcut.
      const safeties = parseBool(req.query.flagged) ? FLAGGED_SAFETY : (parseList(safety) as Safety[]);
      if (safeties.length > 0) {
        const unknown = safeties.filter((value) => !SAFETY_VALUES.includes(value));
        if (unknown.length > 0) throw new BadRequest(`Unknown safety value(s): ${unknown.join(', ')}.`);
        where.push(`k.safety IN (${safeties.map((_, i) => `@saf${i}`).join(', ')})`);
        safeties.forEach((value, i) => (params[`saf${i}`] = value));
      }

      // Source — matches sources.id (so 'manual' works), via the raw article.
      const sources = parseList(source);
      if (sources.length > 0) {
        where.push(`r.sourceId IN (${sources.map((_, i) => `@src${i}`).join(', ')})`);
        sources.forEach((value, i) => (params[`src${i}`] = value));
      }

      // Age target (multi).
      const ages = parseList(ageTarget).map(Number);
      if (ages.length > 0) {
        if (ages.some((age) => !Number.isInteger(age))) throw new BadRequest('ageTarget must be whole numbers.');
        where.push(`k.ageTarget IN (${ages.map((_, i) => `@age${i}`).join(', ')})`);
        ages.forEach((value, i) => (params[`age${i}`] = value));
      }

      // §4.2: free text over kid headline, summary, and the ORIGINAL headline.
      if (typeof q === 'string' && q.trim()) {
        where.push('(k.kidHeadline LIKE @q OR k.summary LIKE @q OR r.headline LIKE @q)');
        // Escape LIKE wildcards so a literal % or _ searches for itself.
        params.q = `%${q.trim().replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
      }

      // §4.2 date range, on either timestamp.
      for (const [param, column] of [
        ['createdFrom', 'k.createdAt >='],
        ['createdTo', 'k.createdAt <='],
        ['publishedFrom', 'k.publishedAt >='],
        ['publishedTo', 'k.publishedAt <='],
      ] as const) {
        const value = req.query[param];
        if (typeof value === 'string' && value.trim()) {
          where.push(`${column} @${param}`);
          params[param] = value.trim();
        }
      }

      // Sort — whitelisted, never interpolated from raw input.
      const sortField = (sort === undefined ? 'createdAt' : String(sort)) as SortField;
      if (!SORTABLE.includes(sortField)) {
        throw new BadRequest(`Cannot sort by '${sortField}'. Expected one of: ${SORTABLE.join(', ')}.`);
      }
      const direction = String(order ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const sql = `
        SELECT k.*, r.sourceId AS sourceId, r.headline AS originalHeadline
        FROM kid_articles k JOIN raw_articles r ON r.id = k.originalId
        ${clause}
        ORDER BY k.${sortField} ${direction}, k.id ASC`;

      const rows = db.prepare(sql).all(params) as AdminRow[];
      res.json({ articles: rows.map(toAdminArticle), total: rows.length });
    } catch (error: unknown) {
      if (error instanceof BadRequest) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  // ─── §4.2 row actions ───────────────────────────────────────────────────
  const setPublished = db.prepare(
    `UPDATE kid_articles SET status='published', publishedAt=@now WHERE id=@id`,
  );
  const setRejected = db.prepare(
    `UPDATE kid_articles SET status='rejected', rejectReason=@reason WHERE id=@id`,
  );
  const setPending = db.prepare(
    `UPDATE kid_articles SET status='pending_review', publishedAt=NULL, rejectReason=NULL WHERE id=@id`,
  );

  function respondWith(res: import('express').Response, id: string): void {
    const row = findRow.get(id) as AdminRow | undefined;
    if (!row) {
      res.status(404).json({ error: `No article with id '${id}'.` });
      return;
    }
    res.json(toAdminArticle(row));
  }

  router.patch('/articles/:id/publish', (req, res) => {
    const existing = findStatus.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }
    setPublished.run({ id: req.params.id, now: new Date().toISOString() });
    respondWith(res, req.params.id);
  });

  router.patch('/articles/:id/reject', (req, res) => {
    const existing = findStatus.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }
    // §4.2: the reason is optional free text, stored on the article.
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    setRejected.run({ id: req.params.id, reason: reason || null });
    respondWith(res, req.params.id);
  });

  router.patch('/articles/:id/unpublish', (req, res) => {
    const existing = findStatus.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }
    // §4.2: "move published/rejected items back to pending_review".
    setPending.run({ id: req.params.id });
    respondWith(res, req.params.id);
  });

  // ─── §4.2 delete — never for published items ────────────────────────────
  router.delete('/articles/:id', (req, res) => {
    const existing = findStatus.get(req.params.id) as { status: ArticleStatus } | undefined;
    if (!existing) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }
    if (existing.status === 'published') {
      res.status(409).json({
        error: 'Published articles cannot be deleted. Unpublish it first, then delete.',
      });
      return;
    }
    db.prepare(`DELETE FROM kid_articles WHERE id = ?`).run(req.params.id);
    res.json({ deleted: req.params.id });
  });

  // ─── §4.2 edit — marks the article as human-edited ──────────────────────
  const EDITABLE_TEXT = [
    'kidHeadline',
    'summary',
    'whatHappened',
    'whyItMatters',
    'thinkAbout',
    'category',
  ] as const;

  router.patch('/articles/:id', (req, res) => {
    const existing = findStatus.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id: req.params.id };

    try {
      for (const field of EDITABLE_TEXT) {
        if (body[field] === undefined) continue;
        const value = String(body[field]).trim();
        if (!value) throw new BadRequest(`${field} cannot be empty.`);
        sets.push(`${field} = @${field}`);
        params[field] = value;
      }

      if (body.feelingNote !== undefined) {
        const value = body.feelingNote === null ? null : String(body.feelingNote).trim();
        sets.push('feelingNote = @feelingNote');
        params.feelingNote = value || null;
      }

      if (body.safety !== undefined) {
        const value = String(body.safety) as Safety;
        if (!SAFETY_VALUES.includes(value)) throw new BadRequest(`Unknown safety '${value}'.`);
        sets.push('safety = @safety');
        params.safety = value;
      }

      if (body.readingMinutes !== undefined) {
        const value = Number(body.readingMinutes);
        if (!Number.isInteger(value) || value < 1) throw new BadRequest('readingMinutes must be a whole number of at least 1.');
        sets.push('readingMinutes = @readingMinutes');
        params.readingMinutes = value;
      }

      if (body.ageTarget !== undefined) {
        const value = Number(body.ageTarget);
        if (!Number.isInteger(value) || value < 5 || value > 14) throw new BadRequest('ageTarget must be a whole number from 5 to 14.');
        sets.push('ageTarget = @ageTarget');
        params.ageTarget = value;
      }

      if (body.vocab !== undefined) {
        const value = body.vocab;
        if (
          !Array.isArray(value) ||
          !value.every(
            (entry): entry is VocabEntry =>
              typeof entry === 'object' && entry !== null &&
              typeof (entry as VocabEntry).word === 'string' &&
              typeof (entry as VocabEntry).definition === 'string',
          )
        ) {
          throw new BadRequest('vocab must be an array of { word, definition }.');
        }
        sets.push('vocab = @vocab');
        params.vocab = JSON.stringify(value);
      }

      if (body.contentWarnings !== undefined) {
        const value = body.contentWarnings;
        if (value !== null && (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))) {
          throw new BadRequest('contentWarnings must be an array of strings, or null.');
        }
        sets.push('contentWarnings = @contentWarnings');
        params.contentWarnings = value === null || value.length === 0 ? null : JSON.stringify(value);
      }

      if (sets.length === 0) throw new BadRequest('No editable fields supplied.');

      // §4.2: "Edits mark the article as edited_by_human."
      sets.push('editedByHuman = 1');

      db.prepare(`UPDATE kid_articles SET ${sets.join(', ')} WHERE id = @id`).run(params);
      respondWith(res, req.params.id);
    } catch (error: unknown) {
      if (error instanceof BadRequest) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  // ─── §4.2 regenerate — preview only, never a silent overwrite ───────────
  const findRaw = db.prepare(`SELECT * FROM raw_articles WHERE id = ?`);

  function regenerate(id: string) {
    const current = findRow.get(id) as AdminRow | undefined;
    if (!current) return null;

    const raw = findRaw.get(current.originalId) as
      | { id: string; headline: string; body: string; topic: string; sourceName: string; sourceUrl: string }
      | undefined;
    if (!raw) return null;

    const config = loadLocalPipelineConfig(db, current.ageTarget);
    const { article } = simplifyLocally(
      { id: raw.id, headline: raw.headline, body: raw.body, topic: raw.topic, sourceName: raw.sourceName, sourceUrl: raw.sourceUrl },
      config,
      { id: current.id, now: current.createdAt },
    );

    // Keep the row's identity and lifecycle fields so the diff shows only what
    // regeneration would actually change.
    return {
      current: toAdminArticle(current),
      generated: {
        ...article,
        status: current.status,
        publishedAt: current.publishedAt,
        rejectReason: current.rejectReason,
        editedByHuman: false,
        sourceId: current.sourceId,
        originalHeadline: current.originalHeadline,
      },
    };
  }

  router.post('/articles/:id/regenerate', (req, res) => {
    const result = regenerate(req.params.id);
    if (!result) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }
    // Nothing is written here. The client shows the diff and calls /apply.
    res.json(result);
  });

  router.post('/articles/:id/regenerate/apply', (req, res) => {
    const result = regenerate(req.params.id);
    if (!result) {
      res.status(404).json({ error: `No article with id '${req.params.id}'.` });
      return;
    }

    const g = result.generated;
    db.prepare(
      `UPDATE kid_articles SET
         kidHeadline=@kidHeadline, summary=@summary, whatHappened=@whatHappened,
         whyItMatters=@whyItMatters, vocab=@vocab, thinkAbout=@thinkAbout,
         feelingNote=@feelingNote, safety=@safety, contentWarnings=@contentWarnings,
         category=@category, readingMinutes=@readingMinutes,
         editedByHuman = 0
       WHERE id=@id`,
    ).run({
      id: req.params.id,
      kidHeadline: g.kidHeadline,
      summary: g.summary,
      whatHappened: g.whatHappened,
      whyItMatters: g.whyItMatters,
      vocab: JSON.stringify(g.vocab),
      thinkAbout: g.thinkAbout,
      feelingNote: g.feelingNote,
      safety: g.safety,
      contentWarnings: g.contentWarnings ? JSON.stringify(g.contentWarnings) : null,
      category: g.category,
      readingMinutes: g.readingMinutes,
    });

    respondWith(res, req.params.id);
  });

  // ─── §4.2 bulk actions ──────────────────────────────────────────────────
  router.post('/articles/bulk', (req, res) => {
    const body = (req.body ?? {}) as { ids?: unknown; action?: unknown; reason?: unknown; includeFlagged?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
    const action = String(body.action ?? '');
    const includeFlagged = parseBool(body.includeFlagged);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array.' });
      return;
    }
    if (!['approve', 'reject', 'delete'].includes(action)) {
      res.status(400).json({ error: `Unknown action '${action}'. Expected approve, reject or delete.` });
      return;
    }

    const applied: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const now = new Date().toISOString();

    db.transaction(() => {
      for (const id of ids) {
        const row = findStatus.get(id) as { status: ArticleStatus; safety: Safety } | undefined;
        if (!row) {
          skipped.push({ id, reason: 'not found' });
          continue;
        }

        if (action === 'approve') {
          // §4.2: bulk approve must not include skip-young unless the editor
          // explicitly opted in.
          if (row.safety === 'skip-young' && !includeFlagged) {
            skipped.push({ id, reason: 'flagged skip-young' });
            continue;
          }
          setPublished.run({ id, now });
        } else if (action === 'reject') {
          setRejected.run({ id, reason: reason || null });
        } else {
          // §4.2: delete only for non-published items.
          if (row.status === 'published') {
            skipped.push({ id, reason: 'published — unpublish first' });
            continue;
          }
          db.prepare(`DELETE FROM kid_articles WHERE id = ?`).run(id);
        }

        applied.push(id);
      }
    })();

    res.json({ action, applied, skipped, appliedCount: applied.length, skippedCount: skipped.length });
  });

  return router;
}
