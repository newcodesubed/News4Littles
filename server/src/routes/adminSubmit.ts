/**
 * Editor portal API — PRD §4.3.
 *
 * NO LLM anywhere. "Simplify with AI" runs the Phase 4 local pipeline
 * (§9.2) — the same function the scraper uses, with the same guard config.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { KidArticle, VocabEntry } from '../db/mappers.js';
import { loadLocalPipelineConfig, simplifyLocally } from '../pipeline/localPipeline.js';

/** §4.2's source dropdown includes 'manual'; §4.3 submissions belong to it. */
const MANUAL_SOURCE_ID = 'manual';

class BadRequest extends Error {}

interface SubmissionInput {
  headline: string;
  sourceName: string;
  sourceUrl: string;
  body: string;
  category: string;
  ageTarget: number;
}

function readSubmission(raw: Record<string, unknown>): SubmissionInput {
  const text = (key: keyof SubmissionInput, label: string): string => {
    const value = typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
    if (!value) throw new BadRequest(`${label} is required.`);
    return value;
  };

  const ageTarget = Number(raw.ageTarget);
  if (!Number.isInteger(ageTarget) || ageTarget < 5 || ageTarget > 14) {
    throw new BadRequest('Age target must be a whole number from 5 to 14.');
  }

  return {
    headline: text('headline', 'Original headline'),
    sourceName: text('sourceName', 'Source name'),
    sourceUrl: text('sourceUrl', 'Source URL'),
    body: text('body', 'Article text'),
    category: text('category', 'Category'),
    ageTarget,
  };
}

/** The kid-facing text an editor may adjust before saving (§4.3 "Review output"). */
const OVERRIDABLE = [
  'kidHeadline',
  'summary',
  'whatHappened',
  'whyItMatters',
  'thinkAbout',
] as const;

export function createAdminSubmitRouter(db: Database): Router {
  const router = Router();

  /**
   * Run the local pipeline over pasted text and return the result WITHOUT
   * writing anything — §4.3's "Simplify with AI" button. The editor reviews the
   * output first (requirement 3: no auto-save).
   */
  router.post('/simplify', (req, res) => {
    try {
      const input = readSubmission((req.body ?? {}) as Record<string, unknown>);
      const config = loadLocalPipelineConfig(db, input.ageTarget);

      const { article, guard } = simplifyLocally(
        {
          id: 'preview',
          headline: input.headline,
          body: input.body,
          topic: input.category,
          sourceName: input.sourceName,
          sourceUrl: input.sourceUrl,
        },
        config,
        { id: 'preview', now: new Date().toISOString() },
      );

      res.json({
        article,
        guard: {
          matches: guard.matches,
          safety: guard.safety,
          denyListEnabled: config.denyListEnabled,
          // So the UI can say honestly which engine produced this.
          engine: 'local-fallback',
        },
      });
    } catch (error: unknown) {
      if (error instanceof BadRequest) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  /**
   * Create a manually submitted article — §4.3 "Send for review" / "Publish".
   *
   * The guard ALWAYS re-runs server-side over the submitted body, and its
   * verdict is what gets stored (requirement 5: identical safety checks, no
   * shortcuts). Editors may adjust the kid-facing TEXT, never the safety
   * classification, from this form. Safety can still be changed afterwards
   * through the review queue's Edit action (§4.2), which is the audited path.
   */
  router.post('/articles', (req, res) => {
    try {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const input = readSubmission(raw);

      const status = String(raw.status ?? 'pending_review');
      if (status !== 'pending_review' && status !== 'published') {
        throw new BadRequest("status must be 'pending_review' or 'published'.");
      }

      const source = db.prepare(`SELECT id, name FROM sources WHERE id = ?`).get(MANUAL_SOURCE_ID);
      if (!source) {
        throw new BadRequest(
          `The '${MANUAL_SOURCE_ID}' source row is missing. Run npm run db:seed.`,
        );
      }

      const config = loadLocalPipelineConfig(db, input.ageTarget);
      const now = new Date().toISOString();
      const rawId = randomUUID();

      const { article } = simplifyLocally(
        {
          id: rawId,
          headline: input.headline,
          body: input.body,
          topic: input.category,
          sourceName: input.sourceName,
          sourceUrl: input.sourceUrl,
        },
        config,
        { id: randomUUID(), now },
      );

      // Apply the editor's text edits on top of the generated output.
      const final: KidArticle = { ...article };
      let edited = false;

      for (const field of OVERRIDABLE) {
        const supplied = raw[field];
        if (typeof supplied !== 'string') continue;
        const value = supplied.trim();
        if (!value) throw new BadRequest(`${field} cannot be empty.`);
        if (value !== final[field]) edited = true;
        final[field] = value;
      }

      if (raw.readingMinutes !== undefined) {
        const value = Number(raw.readingMinutes);
        if (!Number.isInteger(value) || value < 1) {
          throw new BadRequest('readingMinutes must be a whole number of at least 1.');
        }
        if (value !== final.readingMinutes) edited = true;
        final.readingMinutes = value;
      }

      if (raw.vocab !== undefined) {
        const value = raw.vocab;
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
        if (JSON.stringify(value) !== JSON.stringify(final.vocab)) edited = true;
        final.vocab = value;
      }

      db.transaction(() => {
        db.prepare(
          `INSERT INTO raw_articles
             (id, sourceId, sourceName, sourceUrl, url, headline, body, topic, publishedAt, fetchedAt)
           VALUES (@id, @sourceId, @sourceName, @sourceUrl, @url, @headline, @body, @topic, @now, @now)`,
        ).run({
          id: rawId,
          sourceId: MANUAL_SOURCE_ID,
          sourceName: input.sourceName,
          sourceUrl: input.sourceUrl,
          url: input.sourceUrl,
          headline: input.headline,
          body: input.body,
          topic: input.category,
          now,
        });

        db.prepare(
          `INSERT INTO kid_articles
             (id, originalId, ageTarget, kidHeadline, summary, whatHappened, whyItMatters, vocab,
              thinkAbout, feelingNote, safety, contentWarnings, category, readingMinutes,
              sourceName, sourceUrl, status, rejectReason, editedByHuman, createdAt, publishedAt)
           VALUES
             (@id, @originalId, @ageTarget, @kidHeadline, @summary, @whatHappened, @whyItMatters, @vocab,
              @thinkAbout, @feelingNote, @safety, @contentWarnings, @category, @readingMinutes,
              @sourceName, @sourceUrl, @status, NULL, @editedByHuman, @createdAt, @publishedAt)`,
        ).run({
          ...final,
          originalId: rawId,
          vocab: JSON.stringify(final.vocab),
          contentWarnings: final.contentWarnings ? JSON.stringify(final.contentWarnings) : null,
          editedByHuman: edited ? 1 : 0,
          status,
          createdAt: now,
          // Schema CHECK: a published row must carry publishedAt.
          publishedAt: status === 'published' ? now : null,
        });
      })();

      res.status(201).json({ ...final, status, publishedAt: status === 'published' ? now : null });
    } catch (error: unknown) {
      if (error instanceof BadRequest) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  return router;
}
