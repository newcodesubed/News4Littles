/**
 * The one entry point for turning a raw article into a KidArticle.
 *
 * Uses the LLM (§9.1) and reports a failure when it cannot, rather than writing
 * a weaker story. Scraping, the editor portal and Regenerate all call this, so
 * they cannot drift apart — §7.4 requires the sandbox to use the same code path
 * as production, and this is that path.
 */
import type { Database } from 'better-sqlite3';
import { LLM_ENABLED, LLM_MODEL } from '../env.js';
import {
  AGE_BANDS, DEFAULT_AGE, bandForAge, formatAgeBand, type AgeBand, type KidArticle,
} from '../core/article.js';
import { createSettingsRepository } from '../db/repositories/settingsRepository.js';
import { OpenRouterClient } from '../llm/openRouterClient.js';
import {
  LlmResponseError, parseLlmContent, renderPrompt, selectPrompt, type LlmContent,
} from '../llm/llmSimplifier.js';
import { logger } from '../logger.js';
import {
  DENY_LIST_LEAD_CHARS, denyListGuard, leadOf, strictest, type GuardResult,
} from './guard.js';
import { runPromptGuard, type PromptGuardOutcome } from './promptGuard.js';
import { FEELING_NOTE_FALLBACK } from './simplify.js';

/** The RawArticle fields the pipeline reads (PRD §8.2). */
export interface RawArticleInput {
  id: string;
  headline: string;
  body: string;
  topic: string;
  /**
   * True when a person chose `topic` — an editor's manual submission — so the
   * model's category pick must not replace it. Otherwise `topic` is only the
   * scraper's keyword guess, and the model's pick wins.
   */
  topicChosenByEditor?: boolean;
  sourceName: string;
  sourceUrl: string;
}

export interface PipelineConfig {
  /** From guard_config.denyList (§6.1) — editor-managed, never hardcoded here. */
  denyList: string[];
  /** From guard_config.denyListEnabled. A disabled guard does not run (§6). */
  denyListEnabled: boolean;
  /** The band anchor written to kid_articles.ageTarget (§3.6). */
  ageTarget: number;
}

/** The editor-managed deny-list, and the band a version is written for. */
export function loadPipelineConfig(db: Database, ageTarget?: number): PipelineConfig {
  const guardRow = db
    .prepare(`SELECT denyList, denyListEnabled FROM guard_config WHERE id = 'default'`)
    .get() as { denyList: string; denyListEnabled: number } | undefined;

  const settingsRow = db
    .prepare(`SELECT defaultAge FROM app_settings WHERE id = 'default'`)
    .get() as { defaultAge: number } | undefined;

  return {
    denyList: guardRow ? (JSON.parse(guardRow.denyList) as string[]) : [],
    denyListEnabled: guardRow ? guardRow.denyListEnabled === 1 : true,
    // The default age is a READER age (any of 5-14); a version is written for the band it falls in.
    ageTarget: ageTarget ?? bandForAge(settingsRow?.defaultAge ?? DEFAULT_AGE).minAge,
  };
}

export interface SimplifySuccess {
  ok: true;
  article: KidArticle;
  /** The winning guard verdict and which deny-list terms fired. */
  guard: GuardResult;
  model?: string;
  costUsd?: number;
  elapsedMs?: number;
  /** Which prompt was used, for the sandbox and the editor portal. */
  promptSource?: string;
  /** Present when §6.2's prompt guard ran. Off by default. */
  promptGuard?: PromptGuardOutcome;
}

export interface SimplifyFailure {
  ok: false;
  /** Safe to show an editor. */
  reason: string;
  model?: string;
  /** A failed call can still have been billed. */
  costUsd?: number;
  elapsedMs?: number;
}

export type SimplifyOutcome = SimplifySuccess | SimplifyFailure;

export const LLM_OFF_REASON = 'The LLM is turned off, so nothing was simplified.';

/** A caller that supplies its own client has a provider by definition; that is how tests drive the LLM path. */
export const llmAvailable = (client?: OpenRouterClient) => LLM_ENABLED || client !== undefined;

export interface SimplifyOptions {
  /** Injectable so tests are deterministic; defaults to a random UUID. */
  id?: string;
  /** Injectable so tests are deterministic; defaults to now. */
  now?: string;
  /**
   * A band's anchor (AGE_BAND_ANCHORS) for anything that will be stored;
   * callers that only preview may pass any age. Defaults to the band the
   * configured default age falls in.
   */
  ageTarget?: number;
  /** Overrides the stored prompt; the sandbox passes a draft here. */
  promptOverride?: string;
  /** Overrides the configured model. */
  model?: string;
  client?: OpenRouterClient;
  /**
   * A prompt-guard verdict already obtained for this article. §6.2's guard
   * judges the SOURCE text, which does not vary by age, so a caller producing
   * one version per band runs it once and passes the same outcome in for all
   * of them — otherwise the guard costs one call per band instead of one.
   */
  promptGuard?: PromptGuardOutcome;
}

export async function simplifyArticle(
  db: Database,
  raw: RawArticleInput,
  options: SimplifyOptions = {},
): Promise<SimplifyOutcome> {
  if (!llmAvailable(options.client)) return { ok: false, reason: LLM_OFF_REASON };

  const config = loadPipelineConfig(db, options.ageTarget);

  const settings = createSettingsRepository(db);
  const prompts = settings.getPromptConfig();
  const chosen = options.promptOverride
    ? { template: options.promptOverride, source: 'override' }
    : selectPrompt(prompts.genericPrompt, prompts.ageOverrides, config.ageTarget);

  if (!chosen.template.trim()) {
    return { ok: false, reason: 'No prompt is configured, so there was nothing to send.' };
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
  // A caller doing one version per band supplies the verdict rather than
  // paying for it once per band.
  const promptGuard =
    options.promptGuard ??
    (guardConfig.promptGuardEnabled
      ? await runPromptGuard(guardConfig.promptGuardText, promptContext, client)
      : undefined);

  const request = { prompt: renderPrompt(chosen.template, promptContext), model: options.model };
  let result = await client.complete(request);
  let spentUsd = result.ok ? (result.costUsd ?? 0) : 0;
  let parsed = result.ok ? tryParse(result.text) : undefined;

  // A malformed reply is usually a one-off, so it earns one retry on the backup model.
  if (parsed && 'error' in parsed) {
    result = await client.complete({ ...request, backup: true });
    if (result.ok) {
      spentUsd += result.costUsd ?? 0;
      parsed = tryParse(result.text);
    }
  }

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      elapsedMs: result.elapsedMs,
      model: options.model ?? LLM_MODEL,
      costUsd: spentUsd || undefined,
    };
  }

  if (!parsed || 'error' in parsed) {
    return {
      ok: false,
      reason: parsed?.error ?? 'The response could not be understood.',
      model: result.model,
      costUsd: spentUsd,
      elapsedMs: result.elapsedMs,
    };
  }

  const { content } = parsed;

  // --- §6: every enabled guard runs; the strictest wins -----------------
  // The model's own verdict is one input alongside the deny-list, so a model
  // that calls a war story "calm" cannot publish it as calm.
  const guards: GuardResult[] = [];
  if (config.denyListEnabled) {
    // The lead, not the whole body: see DENY_LIST_LEAD_CHARS.
    const lead = leadOf(raw.body, DENY_LIST_LEAD_CHARS);
    guards.push(denyListGuard(`${raw.headline}\n${lead}`, config.denyList));
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
    audioScript: content.audioScript,
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
    category: (!raw.topicChosenByEditor && content.category) || raw.topic,
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
    ok: true,
    article,
    guard: { ...guard, matches: denyMatches },
    model: result.model,
    // Both calls are billed, so both are reported — but a verdict supplied by
    // the caller was billed to the caller, not again to every version.
    costUsd: spentUsd + (options.promptGuard ? 0 : (promptGuard?.costUsd ?? 0)),
    elapsedMs: result.elapsedMs,
    promptSource: chosen.source,
    promptGuard,
  };
}

/** Parses a model reply, logging the start of any reply that cannot be used. */
function tryParse(text: string): { content: LlmContent } | { error: string } {
  try {
    return { content: parseLlmContent(text) };
  } catch (error: unknown) {
    const reason = error instanceof LlmResponseError ? error.message : 'The response could not be understood.';
    logger.warn({ reason, chars: text.length, start: text.slice(0, 300), end: text.slice(-300) }, 'unusable LLM reply');
    return { error: reason };
  }
}

export interface StoryOutcome {
  /** One per band, ascending by band; a band the model could not write is a failure. */
  versions: SimplifyOutcome[];
  /** The shared §6.2 verdict, present only when the guard ran. */
  promptGuard?: PromptGuardOutcome;
  /** Summed across every version plus the one guard call. */
  costUsd: number;
  /** One entry per band that failed, already prefixed with its ages. */
  failures: string[];
}

/**
 * The per-story options, on top of everything one version already takes.
 *
 * `perBand` exists because a REGENERATION rewrites stored rows: each band has
 * to be built with the id and createdAt of the row it will replace, or the
 * versions would either collide on one id or arrive as strangers.
 */
export interface StoryOptions extends Omit<SimplifyOptions, 'ageTarget' | 'promptGuard'> {
  /** Which bands to build, ascending. Defaults to every band (§3.6). */
  bands?: readonly AgeBand[];
  /** Per-band identity, so a regeneration writes back to the stored rows. */
  perBand?: (band: AgeBand) => { id?: string; now?: string } | undefined;
  /** Called with the number of bands attempted so far, for progress polling. */
  onProgress?: (done: number) => void;
}

/** "ages 5–7", for a failure reason a reviewer reads. */
const describeBand = (band: AgeBand) => `ages ${formatAgeBand(band)}`;

/**
 * One version of a story per reading band (AGE_BANDS), so the public slider
 * selects real content rather than relabelling one version.
 *
 * One call per band, not one combined call: every stored prompt template
 * embeds the article and its own JSON envelope, so combining them would either
 * send the article once per band or mangle the templates, and would lose
 * per-band prompt control and the sandbox's fidelity to production (§7.4).
 *
 * The §6.2 prompt guard runs ONCE and is shared, because it judges the source
 * article and that does not vary by band.
 *
 * The bands run at once: three calls per story is well within rate limits.
 */
export async function simplifyStory(
  db: Database,
  raw: RawArticleInput,
  options: StoryOptions = {},
): Promise<StoryOutcome> {
  const settings = createSettingsRepository(db);
  const guardConfig = settings.getGuardConfig();
  const { bands = AGE_BANDS, perBand, onProgress, ...perCall } = options;

  // Shared across every band. Uses the youngest band being built purely to
  // render the guard prompt's {{age}} variable; the verdict is about the
  // source text, which does not vary by band.
  let promptGuard: PromptGuardOutcome | undefined;
  if (guardConfig.promptGuardEnabled && llmAvailable(options.client) && bands.length > 0) {
    const client = options.client ?? new OpenRouterClient({ model: options.model });
    promptGuard = await runPromptGuard(
      guardConfig.promptGuardText,
      {
        headline: raw.headline,
        body: raw.body,
        category: raw.topic,
        sourceName: raw.sourceName,
        age: bands[0]!.minAge,
      },
      client,
    );
  }

  let done = 0;
  const versions = await Promise.all(
    bands.map(async (band) => {
      const outcome = await simplifyArticle(db, raw, {
        ...perCall, ...perBand?.(band), ageTarget: band.minAge, promptGuard,
      });
      done += 1;
      onProgress?.(done);
      return outcome;
    }),
  );

  let costUsd = promptGuard?.costUsd ?? 0;
  const failures: string[] = [];
  versions.forEach((outcome, i) => {
    costUsd += outcome.costUsd ?? 0;
    // Prefixed with the band: a reviewer needs to know WHICH version failed.
    if (!outcome.ok) failures.push(`${describeBand(bands[i]!)}: ${outcome.reason}`);
  });

  // One category per story, like one status: the versions are one story at
  // three reading levels, and the Home filter should not show it under Science
  // at 5-7 and World at 11-14. Bands ascend, so this is the youngest band's pick.
  const written = versions.filter((v): v is SimplifySuccess => v.ok);
  const category = written.find((v) => v.article.category !== raw.topic)?.article.category ?? raw.topic;
  for (const version of written) version.article.category = category;

  return { versions, promptGuard, costUsd, failures };
}
