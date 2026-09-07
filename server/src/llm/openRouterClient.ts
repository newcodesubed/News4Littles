/**
 * The one place that talks to a model provider — PRD §9.1.
 *
 * OpenRouter exposes an OpenAI-compatible chat-completions API, so this is a
 * thin, provider-shaped wrapper rather than an SDK dependency.
 *
 * Never throws for an expected failure: callers get a discriminated result and
 * fall back to the local pipeline (§9.1 step 4). Every cost-bearing knob is a
 * constructor argument so tests can pin them.
 */
import {
  LLM_MAX_RETRIES, LLM_MAX_TOKENS, LLM_MODEL, LLM_TIMEOUT_MS, OPENROUTER_KEY,
} from '../env.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface CompletionRequest {
  prompt: string;
  /** Overrides the configured model; used by the sandbox to compare. */
  model?: string;
  maxTokens?: number;
}

export interface CompletionSuccess {
  ok: true;
  /** The assistant's message content, with any markdown fence stripped. */
  text: string;
  model: string;
  totalTokens: number;
  /** USD, as reported by OpenRouter. Undefined if it did not say. */
  costUsd?: number;
  elapsedMs: number;
}

export interface CompletionFailure {
  ok: false;
  /** Safe to show an editor; never contains the key. */
  reason: string;
  /** True when retrying later might work (rate limit, provider blip). */
  transient: boolean;
  elapsedMs: number;
}

export type CompletionResult = CompletionSuccess | CompletionFailure;

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Models routinely wrap JSON in a ```json fence even when asked for a JSON
 * object — claude-haiku-4.5 does it consistently. Stripping it here means good
 * output is not thrown away as a parse failure.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

/** Transient: worth one retry. Anything else is a real failure. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterOptions = {}) {
    this.apiKey = options.apiKey ?? OPENROUTER_KEY;
    this.model = options.model ?? LLM_MODEL;
    this.maxTokens = options.maxTokens ?? LLM_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? LLM_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();

    if (!this.apiKey) {
      return { ok: false, reason: 'No OPENROUTER_KEY configured.', transient: false, elapsedMs: 0 };
    }

    let last: CompletionFailure = {
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

  private async attempt(request: CompletionRequest, startedAt: number): Promise<CompletionResult> {
    const elapsed = () => Date.now() - startedAt;
    const model = request.model ?? this.model;

    // AbortSignal.timeout keeps a hung provider from stalling the scheduler.
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: request.prompt }],
          // Asks for JSON. Not every model honours it, hence stripCodeFence.
          response_format: { type: 'json_object' },
          max_tokens: request.maxTokens ?? this.maxTokens,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'TimeoutError';
      return {
        ok: false,
        reason: aborted
          ? `The model did not respond within ${this.timeoutMs}ms.`
          : 'Could not reach OpenRouter.',
        transient: true,
        elapsedMs: elapsed(),
      };
    }

    if (!response.ok) {
      // The body may carry a useful provider message; it never carries the key.
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

    interface CompletionBody {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number; cost?: number };
      model?: string;
    }

    let body: CompletionBody;
    try {
      body = (await response.json()) as CompletionBody;
    } catch {
      return { ok: false, reason: 'OpenRouter returned a body that was not JSON.', transient: true, elapsedMs: elapsed() };
    }

    const text = stripCodeFence(body.choices?.[0]?.message?.content ?? '');

    // A reasoning model can spend its whole budget thinking and return nothing
    // — gpt-5-nano does exactly this. Empty content is a failure, not success.
    if (!text) {
      return {
        ok: false,
        reason: 'The model returned no content, which usually means max_tokens was too low.',
        transient: false,
        elapsedMs: elapsed(),
      };
    }

    return {
      ok: true,
      text,
      model: body.model ?? model,
      totalTokens: body.usage?.total_tokens ?? 0,
      costUsd: body.usage?.cost,
      elapsedMs: elapsed(),
    };
  }
}
