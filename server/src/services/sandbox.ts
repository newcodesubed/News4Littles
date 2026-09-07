/**
 * Prompt sandbox use cases — PRD §7.
 *
 * §7.4 is the rule this file exists to keep: nothing here writes production
 * data. A test run reads an article and calls the model; only promote() writes,
 * and only to the prompt tables.
 */
import type { Database } from 'better-sqlite3';
import { BadRequestError, NotFoundError } from '../core/errors.js';
import { MAX_AGE, MIN_AGE, type KidArticle } from '../core/article.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import {
  createPromptRepository, versionKey,
  type PromptTarget, type PromptVersion,
} from '../db/repositories/promptRepository.js';
import { createSettingsRepository } from '../db/repositories/settingsRepository.js';
import { maxWordsForAge, splitSentences } from '../pipeline/simplify.js';
import { simplifyArticle, type SimplifyOutcome } from '../pipeline/simplifyArticle.js';
import { runPromptGuard } from '../pipeline/promptGuard.js';
import { LLM_ENABLED } from '../env.js';
import { OpenRouterClient } from '../llm/openRouterClient.js';

/** The article a run is tested against: a stored one, or pasted text. */
export interface TestSubject {
  articleId?: string;
  rawText?: string;
  headline?: string;
}

export interface ValidationReport {
  schemaValid: boolean;
  parseError?: string;
  /** §7.3: word count per sentence against the age target. */
  ageLimit: number;
  longestSentenceWords: number;
  withinAgeLimit: boolean;
  overLongSentences: string[];
}

export interface SandboxRun {
  target: PromptTarget;
  age: number | null;
  engine: SimplifyOutcome['engine'];
  model?: string;
  elapsedMs?: number;
  costUsd?: number;
  fallbackReason?: string;
  /** Rendered like the story detail page (§7.3), not raw JSON. */
  article?: KidArticle;
  /** For a guard run: the verdict plus the raw response (§7.3). */
  guardVerdict?: string;
  guardRaw?: string;
  validation?: ValidationReport;
}

export interface TestResult {
  subject: { headline: string; body: string; sourceName: string; category: string };
  draft: SandboxRun;
  /** Present when compareWithProduction was asked for (§7.3 comparison mode). */
  production?: SandboxRun;
  /** True when no key is configured, so the UI can say so (§7.4). */
  usingLocalFallback: boolean;
}

function requireAge(age: unknown): number | null {
  if (age === null || age === undefined || age === '') return null;
  const value = Number(age);
  if (!Number.isInteger(value) || value < MIN_AGE || value > MAX_AGE) {
    throw new BadRequestError(`age must be a whole number from ${MIN_AGE} to ${MAX_AGE}, or absent.`);
  }
  return value;
}

/** §7.3: how far the output is from the age's words-per-sentence limit. */
function validate(article: KidArticle, ageTarget: number): ValidationReport {
  const limit = maxWordsForAge(ageTarget);
  const sentences = splitSentences(`${article.summary} ${article.whatHappened} ${article.whyItMatters}`);
  const counts = sentences.map((sentence) => ({
    sentence,
    words: sentence.split(/\s+/).filter(Boolean).length,
  }));

  const longest = counts.reduce((max, entry) => Math.max(max, entry.words), 0);

  return {
    schemaValid: true,
    ageLimit: limit,
    longestSentenceWords: longest,
    withinAgeLimit: longest <= limit,
    overLongSentences: counts.filter((entry) => entry.words > limit).map((entry) => entry.sentence),
  };
}

/** Resolve the article a run tests against, without writing anything. */
function resolveSubject(db: Database, subject: TestSubject) {
  if (subject.articleId) {
    const raw = createRawArticleRepository(db).findById(subject.articleId);
    if (!raw) throw NotFoundError.of('raw article', subject.articleId);
    return {
      id: raw.id, headline: raw.headline, body: raw.body, topic: raw.topic,
      sourceName: raw.sourceName, sourceUrl: raw.sourceUrl,
    };
  }

  const body = (subject.rawText ?? '').trim();
  if (!body) throw new BadRequestError('Provide either articleId or rawText to test against.');

  return {
    id: 'sandbox',
    headline: (subject.headline ?? '').trim() || 'Pasted text',
    body,
    topic: 'World',
    sourceName: 'Sandbox',
    sourceUrl: 'about:blank',
  };
}

export interface TestOptions {
  target: PromptTarget;
  age: number | null;
  promptText: string;
  subject: TestSubject;
  compareWithProduction?: boolean;
  client?: OpenRouterClient;
}

export async function runSandboxTest(db: Database, options: TestOptions): Promise<TestResult> {
  const settings = createSettingsRepository(db);
  const appSettings = settings.getAppSettings();
  const ageTarget = options.age ?? appSettings.defaultAge;
  const raw = resolveSubject(db, options.subject);

  /**
   * Only build a client when an LLM is actually configured. Creating one
   * unconditionally would defeat LLM_ENABLED, because simplifyArticle treats a
   * supplied client as intent to use the model — which made the sandbox tests
   * issue real, billed requests.
   */
  const client = options.client ?? (LLM_ENABLED ? new OpenRouterClient() : undefined);

  /** One run of one prompt. Never writes. */
  const runOnce = async (promptText: string): Promise<SandboxRun> => {
    if (options.target === 'guard') {
      if (!client) {
        return {
          target: 'guard',
          age: options.age,
          engine: 'local-fallback',
          guardRaw: '',
          fallbackReason:
            'The guard prompt needs an LLM. Set OPENROUTER_KEY to try it — the rule-based deny-list still runs.',
        };
      }

      const outcome = await runPromptGuard(
        promptText,
        {
          headline: raw.headline, body: raw.body, category: raw.topic,
          sourceName: raw.sourceName, age: ageTarget,
        },
        client,
      );
      return {
        target: 'guard',
        age: options.age,
        engine: outcome.ok ? 'llm' : 'local-fallback',
        model: outcome.model,
        elapsedMs: outcome.elapsedMs,
        costUsd: outcome.costUsd,
        fallbackReason: outcome.ok ? undefined : outcome.reason,
        guardVerdict: outcome.result?.safety,
        guardRaw: outcome.raw,
      };
    }

    // §7.4: the same code path as production, with the prompt swapped.
    const outcome = await simplifyArticle(db, raw, {
      ageTarget, promptOverride: promptText, client, id: 'sandbox', now: new Date().toISOString(),
    });

    return {
      target: 'simplification',
      age: options.age,
      engine: outcome.engine,
      model: outcome.model,
      elapsedMs: outcome.elapsedMs,
      costUsd: outcome.costUsd,
      fallbackReason: outcome.fallbackReason,
      article: outcome.article,
      validation: {
        ...validate(outcome.article, ageTarget),
        // A fallback means the response could not be used as-is.
        schemaValid: outcome.engine === 'llm',
        parseError: outcome.fallbackReason,
      },
    };
  };

  const draft = await runOnce(options.promptText);

  let production: SandboxRun | undefined;
  if (options.compareWithProduction) {
    const live = productionPrompt(db, options.target, options.age);
    production = live.trim() ? await runOnce(live) : undefined;
  }

  return {
    subject: {
      headline: raw.headline, body: raw.body,
      sourceName: raw.sourceName, category: raw.topic,
    },
    draft,
    production,
    usingLocalFallback: draft.engine === 'local-fallback',
  };
}

/** The prompt currently live for a target+age. */
export function productionPrompt(db: Database, target: PromptTarget, age: number | null): string {
  const settings = createSettingsRepository(db);
  if (target === 'guard') return settings.getGuardConfig().promptGuardText;

  const prompts = settings.getPromptConfig();
  if (age === null) return prompts.genericPrompt;
  return prompts.ageOverrides[String(age)] ?? prompts.genericPrompt;
}

export interface PromoteInput {
  target: PromptTarget;
  age: number | null;
  promptText: string;
  note?: string | null;
  promotedBy: string;
}

/**
 * §7.4: promotion is the ONLY path that writes a production prompt. It bumps
 * the version, records who and when, and clears any draft that has now landed.
 * Existing pending_review articles are deliberately not regenerated.
 */
export function promotePrompt(db: Database, input: PromoteInput): PromptVersion {
  const promptText = input.promptText.trim();
  if (!promptText) throw new BadRequestError('A prompt cannot be promoted empty.');

  const prompts = createPromptRepository(db);
  const settings = createSettingsRepository(db);
  const now = new Date().toISOString();

  let record!: PromptVersion;

  db.transaction(() => {
    record = prompts.recordPromotion(
      {
        target: input.target,
        age: input.age,
        promptText,
        promotedBy: input.promotedBy,
        note: input.note?.trim() || null,
      },
      now,
    );

    if (input.target === 'guard') {
      settings.saveGuardConfig({ ...settings.getGuardConfig(), promptGuardText: promptText }, now);
    } else {
      const current = settings.getPromptConfig();
      const ageOverrides = { ...current.ageOverrides };
      if (input.age !== null) ageOverrides[String(input.age)] = promptText;

      settings.savePromptConfig(
        {
          genericPrompt: input.age === null ? promptText : current.genericPrompt,
          ageOverrides,
        },
        now,
      );
    }

    // The version counter shown in admin settings (§7.5).
    settings.saveVersionCounters(
      { ...prompts.currentVersions() },
      now,
    );

    // The draft has landed, so it is no longer pending.
    prompts.deleteDraft(input.target, input.age);
  })();

  return record;
}

export { requireAge, versionKey };
