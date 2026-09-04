/**
 * Local rule-based guard + simplification pipeline — PRD §6 and §9.2.
 *
 * This is the no-LLM-key path. There are no network calls, no model calls and
 * no `import` of anything that makes one, anywhere in this file or its imports.
 * The LLM path (§9.1) will live beside it and fall back to this one.
 *
 * simplifyLocally() is pure: the deny-list, age target, id and timestamp all
 * arrive as arguments, so the same input always produces the same output.
 * loadLocalPipelineConfig() is the impure half — it reads guard_config and
 * app_settings so the deny-list stays editable from admin settings (§4.4).
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { KidArticle, Safety } from '../db/mappers.js';
import { denyListGuard, strictest, type GuardResult } from './guard.js';
import {
  buildVocab,
  estimateReadingMinutes,
  FEELING_NOTE_FALLBACK,
  simplifyHeadline,
  simplifySentences,
  THINK_ABOUT_FALLBACK,
  WHY_IT_MATTERS_FALLBACK,
} from './simplify.js';

/** The RawArticle fields this pipeline reads (PRD §8.2). */
export interface RawArticleInput {
  id: string;
  headline: string;
  body: string;
  topic: string;
  sourceName: string;
  sourceUrl: string;
}

export interface LocalPipelineConfig {
  /** From guard_config.denyList (§6.1) — editor-managed, never hardcoded here. */
  denyList: string[];
  /** From guard_config.denyListEnabled. A disabled guard does not run (§6). */
  denyListEnabled: boolean;
  /** 5-14; from app_settings.defaultAge unless a caller overrides it (§3.6). */
  ageTarget: number;
}

export interface LocalPipelineOptions {
  /** Injectable so tests are deterministic; defaults to a random UUID. */
  id?: string;
  /** Injectable so tests are deterministic; defaults to now. */
  now?: string;
}

export interface LocalPipelineResult {
  article: KidArticle;
  /** How the safety verdict was reached — for the admin UI and the sandbox. */
  guard: GuardResult;
}

/**
 * ASSUMPTION: the guard reads headline + body together. §6 says it classifies
 * "the article" without saying which fields; a deny-list term in the headline
 * plainly counts.
 */
function guardText(raw: RawArticleInput): string {
  return `${raw.headline}\n${raw.body}`;
}

/**
 * ASSUMPTION: whatHappened takes the first four simplified sentences. §9.2 sets
 * a per-sentence word limit but never says how many sentences a section holds.
 */
const WHAT_HAPPENED_SENTENCES = 4;

export function simplifyLocally(
  raw: RawArticleInput,
  config: LocalPipelineConfig,
  options: LocalPipelineOptions = {},
): LocalPipelineResult {
  // --- Guard (§6) ---------------------------------------------------------
  // Only enabled guards run, and the strictest result wins. The prompt guard
  // (§6.2) would be pushed into this array once it exists.
  const results: GuardResult[] = [];
  if (config.denyListEnabled) {
    results.push(denyListGuard(guardText(raw), config.denyList));
  }
  const guard = strictest(results);

  // --- Simplification (§9.2) ---------------------------------------------
  const sentences = simplifySentences(raw.body, config.ageTarget);
  const kidHeadline = simplifyHeadline(raw.headline, config.ageTarget);

  const summary = sentences[0] ?? kidHeadline;
  const whatHappened = sentences.slice(0, WHAT_HAPPENED_SENTENCES).join(' ') || summary;

  const safety: Safety = guard.safety;
  const createdAt = options.now ?? new Date().toISOString();

  const article: KidArticle = {
    id: options.id ?? randomUUID(),
    originalId: raw.id,
    ageTarget: config.ageTarget,
    kidHeadline,
    summary,
    whatHappened,
    whyItMatters: WHY_IT_MATTERS_FALLBACK,
    vocab: buildVocab(raw.body),
    thinkAbout: THINK_ABOUT_FALLBACK,
    // §3.4 / §11.1: a feeling note belongs only to a non-calm story.
    feelingNote: safety === 'calm' ? null : FEELING_NOTE_FALLBACK[safety],
    safety,
    // The deny-list terms that fired double as the content warnings a grown-up
    // would want to see. ASSUMPTION: the PRD does not say what populates this.
    contentWarnings: guard.matches.length > 0 ? guard.matches : null,
    // §8.2: RawArticle.topic "maps to category".
    category: raw.topic,
    readingMinutes: estimateReadingMinutes(whatHappened),
    sourceName: raw.sourceName,
    sourceUrl: raw.sourceUrl,
    // §5.2 step 7: "Store as pending_review — never auto-publish."
    status: 'pending_review',
    rejectReason: null,
    editedByHuman: false,
    createdAt,
    publishedAt: null,
  };

  return { article, guard };
}

/**
 * Load the editable half of the config from the database, so the deny-list is
 * whatever an editor last saved in admin settings rather than a constant.
 *
 * Falls back to the seeded defaults if a row is missing, so the pipeline still
 * runs against a database that has not been seeded.
 */
export function loadLocalPipelineConfig(db: Database, ageTarget?: number): LocalPipelineConfig {
  const guardRow = db
    .prepare(`SELECT denyList, denyListEnabled FROM guard_config WHERE id = 'default'`)
    .get() as { denyList: string; denyListEnabled: number } | undefined;

  const settingsRow = db
    .prepare(`SELECT defaultAge FROM app_settings WHERE id = 'default'`)
    .get() as { defaultAge: number } | undefined;

  return {
    denyList: guardRow ? (JSON.parse(guardRow.denyList) as string[]) : [],
    denyListEnabled: guardRow ? guardRow.denyListEnabled === 1 : true,
    ageTarget: ageTarget ?? settingsRow?.defaultAge ?? 6,
  };
}
