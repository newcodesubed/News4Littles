/**
 * Request-parsing helpers shared by every route.
 *
 * Each one either returns a well-typed value or throws BadRequestError, which
 * the central error handler turns into a 400. Routes never write status codes
 * for validation failures.
 */
import { BadRequestError } from '../core/errors.js';
import {
  ARTICLE_STATUSES, MAX_AGE, MIN_AGE, SAFETY_VALUES,
  type ArticleStatus, type Safety, type VocabEntry,
} from '../core/article.js';

/** Accepts `?x=a&x=b` and `?x=a,b` interchangeably. */
export function parseList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/** A non-empty, trimmed string. */
export function requireString(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BadRequestError(`${label} is required.`);
  return text;
}

/** A trimmed string, or null when absent/blank. */
export function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function requireInt(
  value: unknown,
  label: string,
  bounds: { min?: number; max?: number } = {},
): number {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new BadRequestError(`${label} must be a whole number.`);

  const { min, max } = bounds;
  if (min !== undefined && max !== undefined && (number < min || number > max)) {
    throw new BadRequestError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  if (min !== undefined && number < min) {
    throw new BadRequestError(`${label} must be a whole number of at least ${min}.`);
  }
  if (max !== undefined && number > max) {
    throw new BadRequestError(`${label} must be a whole number of at most ${max}.`);
  }
  return number;
}

export const requireAgeTarget = (value: unknown, label = 'Age target'): number =>
  requireInt(value, label, { min: MIN_AGE, max: MAX_AGE });

export function requireStatus(value: unknown): ArticleStatus {
  const text = String(value);
  if (!(ARTICLE_STATUSES as readonly string[]).includes(text)) {
    throw new BadRequestError(
      `Unknown status '${text}'. Expected one of: ${ARTICLE_STATUSES.join(', ')}.`,
    );
  }
  return text as ArticleStatus;
}

export function requireSafety(value: unknown): Safety {
  const text = String(value);
  if (!(SAFETY_VALUES as readonly string[]).includes(text)) {
    throw new BadRequestError(`Unknown safety '${text}'.`);
  }
  return text as Safety;
}

export function requireSafetyList(values: string[]): Safety[] {
  const unknown = values.filter((value) => !(SAFETY_VALUES as readonly string[]).includes(value));
  if (unknown.length > 0) throw new BadRequestError(`Unknown safety value(s): ${unknown.join(', ')}.`);
  return values as Safety[];
}

export function requireVocab(value: unknown): VocabEntry[] {
  const isEntry = (entry: unknown): entry is VocabEntry =>
    typeof entry === 'object' && entry !== null &&
    typeof (entry as VocabEntry).word === 'string' &&
    typeof (entry as VocabEntry).definition === 'string';

  if (!Array.isArray(value) || !value.every(isEntry)) {
    throw new BadRequestError('vocab must be an array of { word, definition }.');
  }
  return value;
}

/** An array of strings, or null. Empty collapses to null so the column stays tidy. */
export function requireStringListOrNull(value: unknown, label: string): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new BadRequestError(`${label} must be an array of strings, or null.`);
  }
  return value.length === 0 ? null : value;
}

/** "6:00" and "06:00" both normalise to "06:00". */
export function requireTimeOfDay(value: unknown): string {
  const text = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new BadRequestError(`'${text}' is not a time of day in HH:MM form.`);
  }
  return `${match[1]!.padStart(2, '0')}:${match[2]}`;
}

/** Guards a value used to build SQL (sort columns), so it can never be injected. */
export function requireOneOf<T extends string>(
  value: unknown, allowed: readonly T[], label: string,
): T {
  const text = String(value);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new BadRequestError(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return text as T;
}
