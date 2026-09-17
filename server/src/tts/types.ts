/**
 * The text-to-speech contract — the seam this whole folder exists to create.
 *
 * Everything outside src/tts talks to a `SpeechProvider` and nothing else: it
 * hands over text and gets back audio bytes. It does not know whether those
 * bytes came from OpenRouter, ElevenLabs, Azure or a file on disk, and it holds
 * no provider's key, endpoint, model id or voice name.
 *
 * SWAPPING PROVIDER: write one file in this folder that implements
 * `SpeechProvider`, register it in ./index.ts, set TTS_PROVIDER. No route,
 * service or component changes, because none of them can tell the difference.
 *
 * Shaped like `CompletionResult` in ../llm/openRouterClient.ts on purpose:
 * expected failures are returned, not thrown, so a provider being down is a
 * story without audio rather than a 500 for the whole page.
 */

/** Container formats a provider may be asked for. */
export type SpeechFormat = 'mp3' | 'wav' | 'opus';

/** What each format is called over HTTP, so the route never guesses. */
export const SPEECH_CONTENT_TYPES: Record<SpeechFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
};

export interface SpeechRequest {
  /** Exactly what should be spoken. Already truncated by the caller. */
  text: string;
  /** Provider-specific voice id. Falls back to the provider's default. */
  voice?: string;
  format?: SpeechFormat;
}

export interface SpeechSuccess {
  ok: true;
  audio: Buffer;
  /** From SPEECH_CONTENT_TYPES; what the route puts on the response. */
  contentType: string;
  format: SpeechFormat;
  /** What actually spoke, for logs and for the cache key. */
  model: string;
  voice: string;
  elapsedMs: number;
}

export interface SpeechFailure {
  ok: false;
  /** Safe to log and to show an editor; never contains a key. */
  reason: string;
  /** True when retrying later might work (rate limit, provider blip). */
  transient: boolean;
  elapsedMs: number;
}

export type SpeechResult = SpeechSuccess | SpeechFailure;

export interface SpeechProvider {
  /** The TTS_PROVIDER value that selects this implementation. */
  readonly id: string;
  /**
   * The defaults this instance speaks with. They are part of the cache key, so
   * changing the voice in .env produces new audio instead of serving the old
   * voice forever.
   */
  readonly model: string;
  readonly voice: string;
  readonly format: SpeechFormat;
  speak(request: SpeechRequest): Promise<SpeechResult>;
}
