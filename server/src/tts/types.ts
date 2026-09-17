/**
 * The text-to-speech contract — the seam this folder exists to create.
 *
 * Everything outside src/tts talks to a `SpeechProvider` and nothing else, so
 * it holds no provider's key, endpoint, model id or voice name.
 *
 * SWAPPING PROVIDER: write one file here implementing `SpeechProvider`,
 * register it in ./index.ts, set TTS_PROVIDER. Nothing else changes.
 *
 * Expected failures are returned, not thrown — a provider being down is a
 * story without audio, not a 500 for the whole page.
 */

export type SpeechFormat = 'mp3' | 'wav' | 'opus';

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
  contentType: string;
  format: SpeechFormat;
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
  /** Part of the cache key, so a new voice in .env produces new audio. */
  readonly model: string;
  readonly voice: string;
  readonly format: SpeechFormat;
  speak(request: SpeechRequest): Promise<SpeechResult>;
}
