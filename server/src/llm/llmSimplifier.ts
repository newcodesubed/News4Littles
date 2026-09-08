/**
 * Turning a raw article into a KidArticle with an LLM — PRD §9.1.
 *
 * Two things this file is careful about:
 *
 *  1. The response is untrusted. Every field is validated and coerced before it
 *     can reach the database, because the schema's CHECK constraints will
 *     otherwise reject the row and lose the whole scrape.
 *  2. The model's `safety` value is ONE guard input, not the verdict. §6 says
 *     every enabled guard runs and the strictest result wins, so a model
 *     calling a war story "calm" cannot override the deny-list.
 */
import { LLM_MAX_BODY_CHARS } from '../env.js';
import { SAFETY_VALUES, type Safety, type VocabEntry } from '../core/article.js';

/** §7.3's template variables. */
export interface PromptContext {
  headline: string;
  body: string;
  category: string;
  sourceName: string;
  age: number;
}

/**
 * Substitute the §7.3 variables. The body is truncated first: without a cap,
 * one pasted book would be billed as input tokens.
 */
export function renderPrompt(template: string, context: PromptContext, maxBodyChars = LLM_MAX_BODY_CHARS): string {
  const body =
    context.body.length > maxBodyChars
      ? `${context.body.slice(0, maxBodyChars)}…[truncated]`
      : context.body;

  return template
    .replaceAll('{{headline}}', context.headline)
    .replaceAll('{{body}}', body)
    .replaceAll('{{category}}', context.category)
    .replaceAll('{{sourceName}}', context.sourceName)
    .replaceAll('{{age}}', String(context.age));
}

/** §9.1 step 1: an age-specific override if one exists, else the generic prompt. */
export function selectPrompt(
  generic: string,
  ageOverrides: Record<string, string>,
  ageTarget: number,
): { template: string; source: 'generic' | `age-${number}` } {
  const override = ageOverrides[String(ageTarget)];
  return override && override.trim()
    ? { template: override, source: `age-${ageTarget}` }
    : { template: generic, source: 'generic' };
}

/** The kid-facing content an LLM response may supply. */
export interface LlmContent {
  kidHeadline: string;
  summary: string;
  whatHappened: string;
  whyItMatters: string;
  vocab: VocabEntry[];
  thinkAbout: string;
  feelingNote: string | null;
  /** The model's opinion. Combined with the other guards, never trusted alone. */
  safety: Safety;
  contentWarnings: string[] | null;
  readingMinutes: number;
}

export class LlmResponseError extends Error {}

const REQUIRED_TEXT = ['kidHeadline', 'summary', 'whatHappened', 'whyItMatters', 'thinkAbout'] as const;

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LlmResponseError(`Field '${field}' was missing or empty.`);
  }
  return value.trim();
}

/**
 * Parse and validate a model response into content the database will accept.
 * Throws LlmResponseError, which the caller turns into a local fallback.
 */
export function parseLlmContent(text: string): LlmContent {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new LlmResponseError('Response was not a JSON object.');
    }
    raw = parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof LlmResponseError) throw error;
    throw new LlmResponseError('Response was not valid JSON.');
  }

  const content: Partial<LlmContent> = {};
  for (const field of REQUIRED_TEXT) content[field] = requireText(raw[field], field);

  // Safety must be one of the three; anything else is treated as unusable
  // rather than silently defaulting to calm.
  const safety = String(raw.safety ?? '').trim() as Safety;
  if (!(SAFETY_VALUES as readonly string[]).includes(safety)) {
    throw new LlmResponseError(`Field 'safety' was '${String(raw.safety)}', which is not a known level.`);
  }

  // Vocab entries that are malformed are dropped rather than failing the whole
  // article — a missing word list is a much smaller loss than a lost story.
  const vocab: VocabEntry[] = Array.isArray(raw.vocab)
    ? raw.vocab
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => ({ word: String(entry.word ?? '').trim(), definition: String(entry.definition ?? '').trim() }))
        .filter((entry) => entry.word && entry.definition)
        .slice(0, 4)
    : [];

  const warnings = Array.isArray(raw.contentWarnings)
    ? raw.contentWarnings.map((entry) => String(entry).trim()).filter(Boolean)
    : [];

  const minutes = Number(raw.readingMinutes);
  const feelingNote =
    typeof raw.feelingNote === 'string' && raw.feelingNote.trim() ? raw.feelingNote.trim() : null;

  return {
    ...(content as Pick<LlmContent, (typeof REQUIRED_TEXT)[number]>),
    vocab,
    feelingNote,
    safety,
    contentWarnings: warnings.length > 0 ? warnings : null,
    // Clamp rather than reject: the schema requires >= 1, and a model
    // occasionally returns 0 or a string.
    readingMinutes: Number.isFinite(minutes) && minutes >= 1 ? Math.round(minutes) : 1,
  };
}
