/**
 * The one entry point for turning a raw article into a KidArticle.
 *
 * Tries the LLM path (§9.1) and falls back to the rule-based one (§9.2) on any
 * failure, flagging which ran. Scraping, the editor portal and Regenerate all
 * call this, so they cannot drift apart — §7.4 requires the sandbox to use the
 * same code path as production, and this is that path.
 */
import type { Database } from 'better-sqlite3';
import { LLM_ENABLED, LLM_MODEL } from '../env.js';
import type { KidArticle } from '../core/article.js';
import { createSettingsRepository } from '../db/repositories/settingsRepository.js';
import { OpenRouterClient } from '../llm/openRouterClient.js';
import {
  LlmResponseError, parseLlmContent, renderPrompt, selectPrompt,
} from '../llm/llmSimplifier.js';
import { denyListGuard, strictest, type GuardResult } from './guard.js';
import { runPromptGuard, type PromptGuardOutcome } from './promptGuard.js';
import { FEELING_NOTE_FALLBACK } from './simplify.js';
import {
  loadLocalPipelineConfig, simplifyLocally,
  type LocalPipelineOptions, type RawArticleInput,
} from './localPipeline.js';

export type Engine = 'llm' | 'local-fallback';

export interface SimplifyOutcome {
  article: KidArticle;
  /** The winning guard verdict and which deny-list terms fired. */
  guard: GuardResult;
  engine: Engine;
  model?: string;
  costUsd?: number;
  elapsedMs?: number;
  /** Set when the LLM was tried and did not work (§9.1 step 4). */
  fallbackReason?: string;
  /** Which prompt was used, for the sandbox and the editor portal. */
  promptSource?: string;
  /** Present when §6.2's prompt guard ran. Off by default. */
  promptGuard?: PromptGuardOutcome;
}

export interface SimplifyOptions extends LocalPipelineOptions {
  ageTarget?: number;
  /** Force the rule-based path — used to produce a comparison. */
  forceLocal?: boolean;
  /** Overrides the stored prompt; the sandbox passes a draft here. */
  promptOverride?: string;
  /** Overrides the configured model. */
  model?: string;
  client?: OpenRouterClient;
}

export async function simplifyArticle(
  db: Database,
  raw: RawArticleInput,
  options: SimplifyOptions = {},
): Promise<SimplifyOutcome> {
  const config = loadLocalPipelineConfig(db, options.ageTarget);
  const local = () => {
    const { article, guard } = simplifyLocally(raw, config, options);
    return { article, guard };
  };

  // A caller that supplies its own client has a provider by definition — that
  // is how tests and the sandbox drive the LLM path without depending on the
  // ambient LLM_ENABLED flag. forceLocal always wins.
  const useLlm = (LLM_ENABLED || options.client !== undefined) && !options.forceLocal;

  if (!useLlm) {
    const { article, guard } = local();
    return { article, guard, engine: 'local-fallback' };
  }

  const settings = createSettingsRepository(db);
  const prompts = settings.getPromptConfig();
  const chosen = options.promptOverride
    ? { template: options.promptOverride, source: 'override' }
    : selectPrompt(prompts.genericPrompt, prompts.ageOverrides, config.ageTarget);

  if (!chosen.template.trim()) {
    const { article, guard } = local();
    return {
      article, guard, engine: 'local-fallback',
      fallbackReason: 'No prompt is configured, so there was nothing to send.',
    };
  }

  const client = options.client ?? new OpenRouterClient({ model: options.model });

  // §6.2: an optional second opinion on safety. Off unless an editor enables
  // it, because it costs a second call per article.
  const guardConfig = settings.getGuardConfig();
  const promptContext = {
    headline: raw.headline,
    body: raw.body,
    category: raw.topic,
    sourceName: raw.sourceName,
    age: config.ageTarget,
  };
  const promptGuard = guardConfig.promptGuardEnabled
    ? await runPromptGuard(guardConfig.promptGuardText, promptContext, client)
    : undefined;

  const result = await client.complete({
    prompt: renderPrompt(chosen.template, promptContext),
    model: options.model,
  });

  if (!result.ok) {
    const { article, guard } = local();
    return {
      article, guard, engine: 'local-fallback',
      fallbackReason: result.reason,
      elapsedMs: result.elapsedMs,
      model: options.model ?? LLM_MODEL,
    };
  }

  try {
    const content = parseLlmContent(result.text);

    // --- §6: every enabled guard runs; the strictest wins -----------------
    // The model's own verdict is one input alongside the deny-list, so a model
    // that calls a war story "calm" cannot publish it as calm.
    const guards: GuardResult[] = [];
    if (config.denyListEnabled) {
      guards.push(denyListGuard(`${raw.headline}\n${raw.body}`, config.denyList));
    }
    guards.push({ guard: 'llm-simplifier', safety: content.safety, matches: [] });
    // A guard that failed contributes nothing rather than a made-up verdict.
    if (promptGuard?.result) guards.push(promptGuard.result);

    const guard = strictest(guards);
    const denyMatches = guards.find((g) => g.guard === 'deny-list')?.matches ?? [];

    const article: KidArticle = {
      id: options.id ?? crypto.randomUUID(),
      originalId: raw.id,
      ageTarget: config.ageTarget,
      kidHeadline: content.kidHeadline,
      summary: content.summary,
      whatHappened: content.whatHappened,
      whyItMatters: content.whyItMatters,
      vocab: content.vocab,
      thinkAbout: content.thinkAbout,
      // §3.4 / §11.1: a feeling note belongs only to a non-calm story. If the
      // guard raised the level above what the model expected, the model may
      // not have written one — use the fixed fallback text rather than none.
      feelingNote:
        guard.safety === 'calm'
          ? null
          : (content.feelingNote ?? FEELING_NOTE_FALLBACK[guard.safety]),
      safety: guard.safety,
      contentWarnings:
        content.contentWarnings ?? (denyMatches.length > 0 ? denyMatches : null),
      category: raw.topic,
      readingMinutes: content.readingMinutes,
      sourceName: raw.sourceName,
      sourceUrl: raw.sourceUrl,
      // §5.2 step 7: never auto-publish.
      status: 'pending_review',
      rejectReason: null,
      editedByHuman: false,
      createdAt: options.now ?? new Date().toISOString(),
      publishedAt: null,
    };

    return {
      article,
      guard: { ...guard, matches: denyMatches },
      engine: 'llm',
      model: result.model,
      // Both calls are billed, so both are reported.
      costUsd: (result.costUsd ?? 0) + (promptGuard?.costUsd ?? 0),
      elapsedMs: result.elapsedMs,
      promptSource: chosen.source,
      promptGuard,
    };
  } catch (error: unknown) {
    // §9.1 step 4: parsing failed, so fall back and flag it.
    const { article, guard } = local();
    return {
      article, guard, engine: 'local-fallback',
      fallbackReason:
        error instanceof LlmResponseError ? error.message : 'The response could not be understood.',
      model: result.model,
      costUsd: result.costUsd,
      elapsedMs: result.elapsedMs,
    };
  }
}
