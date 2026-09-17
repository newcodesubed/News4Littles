/**
 * Which voice is speaking — the ONE place that knows.
 *
 * Callers ask for `createSpeechProvider()` and get a `SpeechProvider`. They
 * never name OpenRouter, never read a key, and never import a provider module,
 * so swapping provider is a change to this file and one new sibling.
 *
 * To add a provider:
 *   1. Write ./elevenLabsSpeech.ts implementing SpeechProvider (copy
 *      ./openRouterSpeech.ts — it is the reference implementation).
 *   2. Add one line to PROVIDERS below.
 *   3. Set TTS_PROVIDER=elevenlabs in .env.
 * Nothing in src/routes, src/services or web/ changes.
 */
import { TTS_ENABLED, TTS_PROVIDER } from '../env.js';
import { OpenRouterSpeechProvider } from './openRouterSpeech.js';
import type { SpeechProvider } from './types.js';

export * from './types.js';
export { OpenRouterSpeechProvider } from './openRouterSpeech.js';

/**
 * The registry. Each entry is a no-argument factory because a provider reads
 * its OWN configuration from env.ts — that is what keeps its key, endpoint and
 * voice vocabulary from leaking into a shared options type that every other
 * provider would then have to pretend to understand.
 */
const PROVIDERS: Record<string, () => SpeechProvider> = {
  openrouter: () => new OpenRouterSpeechProvider(),
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * The configured provider, or null when speech is switched off.
 *
 * Null rather than a throw: no voice is a page without a play button, which is
 * the same shape as no LLM key being a rule-based story (§9.2). An UNKNOWN
 * TTS_PROVIDER does throw, because that is a typo in .env, not a decision.
 */
export function createSpeechProvider(id: string = TTS_PROVIDER): SpeechProvider | null {
  // The id is validated BEFORE the enabled check, deliberately: a misspelled
  // TTS_PROVIDER is still a misspelling when speech is off, and finding out
  // about it at startup beats finding out the day it is switched on.
  const factory = PROVIDERS[id];
  if (!factory) {
    throw new Error(
      `TTS_PROVIDER '${id}' is not a known provider. Known: ${PROVIDER_IDS.join(', ')}.`,
    );
  }

  return TTS_ENABLED ? factory() : null;
}
