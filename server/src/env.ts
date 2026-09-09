/**
 * Every environment variable the server reads, in one place.
 *
 * Values come from server/.env (see .env.example for the documented list).
 * Real shell variables always win over the file, so a one-off override still
 * works:  PORT=5000 npm run dev
 *
 * Import config from here rather than touching process.env elsewhere — that
 * keeps defaults, parsing and validation in a single module.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/** Repo path: /server */
export const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Loaded at import time, before any other module reads process.env.
config({ path: resolve(SERVER_ROOT, '.env'), quiet: true });

function readString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'.`);
  }
  return value;
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const values = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} was set but contained no values.`);
  }
  return values;
}

/** Port the API listens on. */
export const PORT = readInt('PORT', 4000);

/** Origins allowed to call the API. The default is the Vite dev server. */
export const CORS_ORIGINS = readList('CORS_ORIGIN', [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

/** SQLite file. A relative value resolves against /server, not the shell's cwd. */
export const DATABASE_PATH = resolve(SERVER_ROOT, readString('DATABASE_PATH', 'data/news4littles.db'));

/**
 * Scheduled scraping (§5.3). The TIMES come from app_settings.scrapeTimes so an
 * editor can change them; these two control whether the scheduler runs at all
 * and which timezone "06:00" is measured in — neither is specified by the PRD.
 */
export const SCRAPE_ENABLED = readString('SCRAPE_ENABLED', 'true').toLowerCase() !== 'false';
export const SCRAPE_TIMEZONE = readString(
  'SCRAPE_TIMEZONE',
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
);

/**
 * LLM simplification (PRD §9.1) via OpenRouter's OpenAI-compatible API.
 *
 * The KEY lives here and nowhere else — never in the database, never in seed
 * data, never committed (§13.2). Everything else is a cost control: without a
 * body cap and a token cap, one pathological article could cost real money.
 */
export const OPENROUTER_KEY = readString('OPENROUTER_KEY', '');

/** Master switch. Off, or with no key, the local fallback (§9.2) runs. */
export const LLM_ENABLED =
  readString('LLM_ENABLED', 'true').toLowerCase() !== 'false' && OPENROUTER_KEY !== '';

/**
 * Auto mode: an LLM judges freshly simplified stories and publishes the ones it
 * approves, with no editor involved.
 *
 * Defaults to FALSE, unlike SCRAPE_ENABLED and LLM_ENABLED. Those default on
 * because they add capability; this one removes the human review §2.2 promises,
 * so it has to be asked for explicitly. Requires a working LLM: no key means no
 * judge, and no judge means nothing is auto-published.
 */
export const AUTO_APPROVE_ENABLED =
  readString('AUTO_APPROVE_ENABLED', 'false').toLowerCase() === 'true' && LLM_ENABLED;

export const LLM_MODEL = readString('LLM_MODEL', 'google/gemini-2.5-flash-lite');

/** Upper bound on the priced half of a response. */
export const LLM_MAX_TOKENS = readInt('LLM_MAX_TOKENS', 1500);

/** Article text is truncated to this before being sent, to bound input cost. */
export const LLM_MAX_BODY_CHARS = readInt('LLM_MAX_BODY_CHARS', 6000);

export const LLM_TIMEOUT_MS = readInt('LLM_TIMEOUT_MS', 30_000);

/** Retries are for transient failures only (429, 5xx); never a retry storm. */
export const LLM_MAX_RETRIES = readInt('LLM_MAX_RETRIES', 1);

/** Admin credentials, used by the seed to create the account (PRD §4.1). */
export const ADMIN_USERNAME = readString('ADMIN_USERNAME', 'admin');
export const ADMIN_PASSWORD = readString('ADMIN_PASSWORD', 'admin123');
