/**
 * The LLM prompt guard — PRD §6.2.
 *
 * A second, independent opinion on safety, combined with the deny-list by
 * strictest-wins (§6). Off by default: the simplification call already carries
 * a classification, so this exists for editors who want a dedicated check, and
 * it costs a second call when they turn it on.
 *
 * §6.2 states the guard answers `safe` | `adult-nearby` | `skip` — a different
 * vocabulary from the Safety type used everywhere else, so it is mapped here.
 */
import type { Safety } from '../core/article.js';
import { renderPrompt, type PromptContext } from '../llm/llmSimplifier.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import type { GuardResult } from './guard.js';

/** §6.2's answers, mapped onto the levels the rest of the app uses. */
const VERDICT_TO_SAFETY: Record<string, Safety> = {
  safe: 'calm',
  'adult-nearby': 'adult-nearby',
  skip: 'skip-young',
  // Accepted as courtesy: a model often answers in our own vocabulary instead.
  calm: 'calm',
  'skip-young': 'skip-young',
};

export interface PromptGuardOutcome {
  /** Present only when the guard produced a usable verdict. */
  result?: GuardResult;
  /** §7.3: the results panel shows "the guard's raw response". */
  raw: string;
  ok: boolean;
  reason?: string;
  model?: string;
  costUsd?: number;
  elapsedMs?: number;
}

/**
 * Read a verdict out of a response.
 *
 * Tries JSON first, then falls back to finding one of the known words in the
 * text — a guard prompt often answers with a single word, and rejecting that
 * would make the feature needlessly brittle.
 */
export function readVerdict(text: string): Safety | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const value = String((parsed as Record<string, unknown>).safety ?? '').trim().toLowerCase();
      if (VERDICT_TO_SAFETY[value]) return VERDICT_TO_SAFETY[value];
    }
  } catch {
    // Not JSON; fall through to the word scan.
  }

  const lowered = text.toLowerCase();
  // Longest first, so "skip-young" is not read as "skip".
  for (const verdict of ['adult-nearby', 'skip-young', 'skip', 'calm', 'safe']) {
    if (new RegExp(`\\b${verdict}\\b`).test(lowered)) return VERDICT_TO_SAFETY[verdict];
  }
  return undefined;
}

export async function runPromptGuard(
  promptText: string,
  context: PromptContext,
  client: OpenRouterClient,
): Promise<PromptGuardOutcome> {
  if (!promptText.trim()) {
    return { ok: false, raw: '', reason: 'No guard prompt is configured.' };
  }

  const completion = await client.complete({ prompt: renderPrompt(promptText, context) });

  if (!completion.ok) {
    return { ok: false, raw: '', reason: completion.reason, elapsedMs: completion.elapsedMs };
  }

  const safety = readVerdict(completion.text);

  if (!safety) {
    // Deliberately does NOT invent a verdict. An unreadable guard contributes
    // nothing, leaving the deny-list to decide, rather than silently passing
    // the article as calm.
    return {
      ok: false,
      raw: completion.text,
      reason: 'The guard response did not contain a recognisable verdict.',
      model: completion.model,
      costUsd: completion.costUsd,
      elapsedMs: completion.elapsedMs,
    };
  }

  return {
    ok: true,
    raw: completion.text,
    result: { guard: 'prompt-guard', safety, matches: [] },
    model: completion.model,
    costUsd: completion.costUsd,
    elapsedMs: completion.elapsedMs,
  };
}
