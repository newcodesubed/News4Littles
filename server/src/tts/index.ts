/**
 * Which voice is speaking — the ONE place that knows.
 *
 * To add a provider:
 *   1. Write ./elevenLabsSpeech.ts implementing SpeechProvider
 *      (./openRouterSpeech.ts is the reference implementation).
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
 * Each entry takes no arguments because a provider reads its OWN config from
 * env.ts — that is what keeps one provider's key and voice vocabulary out of a
 * shared options type every other provider would have to understand.
 */
const PROVIDERS: Record<string, () => SpeechProvider> = {
  openrouter: () => new OpenRouterSpeechProvider(),
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * The configured provider, or null when speech is switched off — no voice is a
 * page without a play button, the same shape as no LLM key being a rule-based
 * story (§9.2). An unknown id throws instead, because that is a typo in .env.
 */
export function createSpeechProvider(id: string = TTS_PROVIDER): SpeechProvider | null {
  // Validated before the enabled check: a misspelling is still a misspelling
  // when speech is off, and startup is the right time to hear about it.
  const factory = PROVIDERS[id];
  if (!factory) {
    throw new Error(
      `TTS_PROVIDER '${id}' is not a known provider. Known: ${PROVIDER_IDS.join(', ')}.`,
    );
  }

  return TTS_ENABLED ? factory() : null;
}
