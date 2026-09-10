/**
 * Manual submission — PRD §4.3.
 *
 * NO LLM. "Simplify with AI" is the Phase 4 local pipeline (§9.2), the same
 * function the scraper calls, reading the same guard config.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../core/errors.js';
import type { ArticleStatus, KidArticle, VocabEntry } from '../core/article.js';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { createSourceRepository } from '../db/repositories/sourceRepository.js';
import { loadLocalPipelineConfig } from '../pipeline/localPipeline.js';
import {
  simplifyArticle, simplifyArticleForAllAges, type SimplifyOutcome,
} from '../pipeline/simplifyArticle.js';
import type { GuardResult } from '../pipeline/guard.js';

/** §4.2's source dropdown includes 'manual'; §4.3 submissions belong to it. */
export const MANUAL_SOURCE_ID = 'manual';

export interface Submission {
  headline: string;
  sourceName: string;
  sourceUrl: string;
  body: string;
  category: string;
  ageTarget: number;
}

/** Kid-facing text the editor may adjust before saving (§4.3 "Review output"). */
export interface ContentOverrides {
  kidHeadline?: string;
  summary?: string;
  whatHappened?: string;
  whyItMatters?: string;
  thinkAbout?: string;
  readingMinutes?: number;
  vocab?: VocabEntry[];
}

export interface SimplifyPreview {
  article: KidArticle;
  guard: GuardResult & {
    denyListEnabled: boolean;
    /** Which engine produced this — §7.4 requires the UI to say so. */
    engine: SimplifyOutcome['engine'];
    model?: string;
    costUsd?: number;
    elapsedMs?: number;
    fallbackReason?: string;
  };
}

function toRawInput(submission: Submission, id: string) {
  return {
    id,
    headline: submission.headline,
    body: submission.body,
    topic: submission.category,
    sourceName: submission.sourceName,
    sourceUrl: submission.sourceUrl,
  };
}

/** Preview only — writes nothing (§4.3: the editor reviews before saving). */
export async function simplifySubmission(
  db: Database,
  submission: Submission,
): Promise<SimplifyPreview> {
  const outcome = await simplifyArticle(db, toRawInput(submission, 'preview'), {
    ageTarget: submission.ageTarget,
    id: 'preview',
  });

  return {
    article: outcome.article,
    guard: {
      ...outcome.guard,
      denyListEnabled: loadLocalPipelineConfig(db, submission.ageTarget).denyListEnabled,
      engine: outcome.engine,
      model: outcome.model,
      costUsd: outcome.costUsd,
      elapsedMs: outcome.elapsedMs,
      fallbackReason: outcome.fallbackReason,
    },
  };
}

/**
 * Store a manual submission as a full story — one version per reading age.
 *
 * A story is one raw article's ten age versions (§3.6), and every story-scoped
 * action assumes they exist: a submission saved at one age could be published
 * but never regenerated for the other nine, and readers outside that age saw
 * nothing. So this runs the same all-ages pass the scraper does, which also
 * spends ONE §6.2 prompt-guard call for the story rather than one per age.
 *
 * The form reviews a single age, so the editor's text edits belong to THAT
 * version only; the other nine are machine output and stay unedited, keeping
 * editedByHuman per-version as §5 requires. The reviewed version is what comes
 * back, so the route's response is the article the editor was looking at.
 *
 * The guard ALWAYS re-runs here, and its verdict is what gets saved: an editor
 * may adjust the kid-facing TEXT from this form, never the safety
 * classification. Safety can still be corrected afterwards through the review
 * queue's Edit action (§4.2), which is the audited path.
 */
export async function createManualArticle(
  db: Database,
  submission: Submission,
  overrides: ContentOverrides,
  status: Extract<ArticleStatus, 'pending_review' | 'published'>,
): Promise<KidArticle> {
  const sources = createSourceRepository(db);
  if (!sources.exists(MANUAL_SOURCE_ID)) {
    throw new BadRequestError(
      `The '${MANUAL_SOURCE_ID}' source row is missing. Run npm run db:seed.`,
    );
  }

  const now = new Date().toISOString();
  const rawId = randomUUID();
  const outcome = await simplifyArticleForAllAges(db, toRawInput(submission, rawId), { now });

  // The age the form previewed. Falls back to the youngest only if the age
  // vanished from the range between validation and here, which it cannot.
  const reviewed =
    outcome.versions.find((version) => version.article.ageTarget === submission.ageTarget)
    ?? outcome.versions[0];

  // Apply the editor's edits on top of the generated output, tracking whether
  // anything actually changed so editedByHuman stays truthful.
  let edited = false;
  const final: KidArticle = { ...reviewed.article };

  const applyText = (key: 'kidHeadline' | 'summary' | 'whatHappened' | 'whyItMatters' | 'thinkAbout') => {
    const value = overrides[key];
    if (value === undefined) return;
    if (value !== final[key]) edited = true;
    final[key] = value;
  };
  (['kidHeadline', 'summary', 'whatHappened', 'whyItMatters', 'thinkAbout'] as const).forEach(applyText);

  if (overrides.readingMinutes !== undefined) {
    if (overrides.readingMinutes !== final.readingMinutes) edited = true;
    final.readingMinutes = overrides.readingMinutes;
  }

  if (overrides.vocab !== undefined) {
    if (JSON.stringify(overrides.vocab) !== JSON.stringify(final.vocab)) edited = true;
    final.vocab = overrides.vocab;
  }

  const lifecycle = {
    originalId: rawId,
    status,
    createdAt: now,
    // Schema CHECK: a published row must carry publishedAt.
    publishedAt: status === 'published' ? now : null,
  } as const;

  const stored: KidArticle = { ...final, ...lifecycle, editedByHuman: edited };
  const rows: KidArticle[] = outcome.versions.map((version) =>
    version === reviewed
      ? stored
      : { ...version.article, ...lifecycle, editedByHuman: false },
  );

  db.transaction(() => {
    createRawArticleRepository(db).insert({
      id: rawId,
      sourceId: MANUAL_SOURCE_ID,
      sourceName: submission.sourceName,
      sourceUrl: submission.sourceUrl,
      url: submission.sourceUrl,
      headline: submission.headline,
      body: submission.body,
      topic: submission.category,
      publishedAt: now,
      fetchedAt: now,
      // §4.3 submissions arrive already simplified, in the same transaction, so
      // they must never appear in the "not yet simplified" backlog.
      simplifiedAt: now,
    });

    // Every version commits with the raw article: a story holding some of its
    // ages cannot be reviewed or published coherently.
    const articles = createArticleRepository(db);
    for (const row of rows) articles.insert(row);
  })();

  return stored;
}
