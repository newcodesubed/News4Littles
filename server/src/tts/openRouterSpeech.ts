/**
 * OpenRouter's /audio/speech endpoint, behind the SpeechProvider contract.
 *
 * This is ONE implementation of ./types.ts, not the interface itself — delete
 * this file, write another, and the rest of the server is unaffected.
 *
 * Two things differ from ../llm/openRouterClient.ts, which talks to the chat
 * endpoint next door:
 *
 *  * The success body is raw audio bytes, not JSON. Only a FAILURE comes back
 *    as JSON, so the content type decides how the response is read.
 *  * `voice` ids are per-model and are not interchangeable. mai-voice-2 wants
 *    Azure names ('en-US-AvaNeural'), voxtral wants 'en_paul_neutral', and the
 *    wrong one is a 400/404 from the provider rather than a fallback voice.
 *
 * Worth recording, because it is the reason this file is not named after GPT:
 * OpenRouter does not serve OpenAI's TTS models. Asking for
 * openai/gpt-4o-mini-tts here answers 400 "Model ... does not exist", and
 * openai/gpt-audio-mini is a streaming CHAT model, not a speech endpoint.
 */
import {
  OPENROUTER_KEY, TTS_MAX_RETRIES, TTS_MODEL, TTS_TIMEOUT_MS, TTS_VOICE,
} from '../env.js';
import {
  SPEECH_CONTENT_TYPES,
  type SpeechFormat, type SpeechFailure, type SpeechProvider,
  type SpeechRequest, type SpeechResult,
} from './types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';

export interface OpenRouterSpeechOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  format?: SpeechFormat;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injectable for tests, so no suite ever spends money. */
  fetchImpl?: typeof fetch;
}

/** Transient: worth one retry. Anything else is a real failure. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export class OpenRouterSpeechProvider implements SpeechProvider {
  readonly id = 'openrouter';
  readonly model: string;
  readonly voice: string;
  readonly format: SpeechFormat;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterSpeechOptions = {}) {
    this.apiKey = options.apiKey ?? OPENROUTER_KEY;
    this.model = options.model ?? TTS_MODEL;
    this.voice = options.voice ?? TTS_VOICE;
    this.format = options.format ?? 'mp3';
    this.timeoutMs = options.timeoutMs ?? TTS_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? TTS_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async speak(request: SpeechRequest): Promise<SpeechResult> {
    const startedAt = Date.now();

    if (!this.apiKey) {
      return { ok: false, reason: 'No OPENROUTER_KEY configured.', transient: false, elapsedMs: 0 };
    }
    if (!request.text.trim()) {
      return { ok: false, reason: 'There is nothing to speak.', transient: false, elapsedMs: 0 };
    }

    let last: SpeechFailure = {
      ok: false, reason: 'Request was never attempted.', transient: false, elapsedMs: 0,
    };

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const result = await this.attempt(request, startedAt);
      if (result.ok) return result;

      last = result;
      // Only a transient failure is worth another paid attempt.
      if (!result.transient) return result;
    }

    return last;
  }

  private async attempt(request: SpeechRequest, startedAt: number): Promise<SpeechResult> {
    const elapsed = () => Date.now() - startedAt;
    const voice = request.voice ?? this.voice;
    const format = request.format ?? this.format;

    // AbortSignal.timeout keeps a hung provider from holding a request open.
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: request.text,
          voice,
          response_format: format,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'TimeoutError';
      return {
        ok: false,
        reason: aborted
          ? `The voice did not respond within ${this.timeoutMs}ms.`
          : 'Could not reach OpenRouter.',
        transient: true,
        elapsedMs: elapsed(),
      };
    }

    if (!response.ok) {
      // A failure body is JSON and may carry a useful provider message; it
      // never carries the key. A bad voice id arrives here, as a 400 or 404.
      let detail = '';
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? '';
      } catch {
        // Non-JSON error body; the status alone is the message.
      }
      return {
        ok: false,
        reason: `OpenRouter returned ${response.status}${detail ? `: ${detail}` : ''}`,
        transient: isTransient(response.status),
        elapsedMs: elapsed(),
      };
    }

    const audio = Buffer.from(await response.arrayBuffer());

    // A 200 carrying no bytes is a failure, not silence worth caching.
    if (audio.byteLength === 0) {
      return {
        ok: false, reason: 'OpenRouter returned an empty audio body.',
        transient: true, elapsedMs: elapsed(),
      };
    }

    return {
      ok: true,
      audio,
      contentType: SPEECH_CONTENT_TYPES[format],
      format,
      model: this.model,
      voice,
      elapsedMs: elapsed(),
    };
  }
}
