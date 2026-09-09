/** Bulk approve / reject / delete over a selected set (§4.2). */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../../core/errors.js';
import { createArticleRepository } from '../../db/repositories/articleRepository.js';
import { optionalString, parseBool, requireOneOf } from '../../http/validation.js';

const ACTIONS = ['approve', 'reject', 'delete'] as const;
type BulkAction = (typeof ACTIONS)[number];

interface BulkOutcome {
  applied: string[];
  skipped: { id: string; reason: string }[];
}

export function createArticleBulkRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);

  router.post('/articles/bulk', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.length === 0) throw new BadRequestError('ids must be a non-empty array.');

    const action: BulkAction = requireOneOf(body.action, ACTIONS, 'action');
    const includeFlagged = parseBool(body.includeFlagged);
    const reason = optionalString(body.reason);
    const now = new Date().toISOString();

    const outcome: BulkOutcome = { applied: [], skipped: [] };

    db.transaction(() => {
      // §5: actions are story-scoped, so several selected versions of one story
      // are one action. Deduplicated by originalId, or a story with ten
      // versions selected would be reported as ten approvals.
      const done = new Set<string>();

      for (const id of ids) {
        const state = articles.findStoryState(id);
        if (!state) {
          outcome.skipped.push({ id, reason: 'not found' });
          continue;
        }
        if (done.has(state.originalId)) continue;

        if (action === 'approve') {
          // §4.2: bulk approve must leave skip-young out unless the editor
          // explicitly opted in — judged on the story's STRICTEST version, so
          // selecting a calm age-14 row cannot publish a skip-young age-5 one.
          if (state.safety === 'skip-young' && !includeFlagged) {
            outcome.skipped.push({ id, reason: 'flagged skip-young' });
            continue;
          }
          articles.publishStory(id, now);
        } else if (action === 'reject') {
          articles.rejectStory(id, reason);
        } else {
          // §4.2: delete only for non-published items.
          if (state.status === 'published') {
            outcome.skipped.push({ id, reason: 'published — unpublish first' });
            continue;
          }
          articles.removeStory(id);
        }

        done.add(state.originalId);
        outcome.applied.push(id);
      }
    })();

    res.json({
      action,
      ...outcome,
      appliedCount: outcome.applied.length,
      skippedCount: outcome.skipped.length,
    });
  });

  return router;
}
