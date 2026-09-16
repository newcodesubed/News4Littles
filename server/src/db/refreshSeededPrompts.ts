/**
 * Carry an improved seeded prompt to a database that already has one.
 *
 * `npm run db:seed` writes translation_prompt_config with ON CONFLICT DO
 * NOTHING, so a database seeded once keeps that first text for good — even
 * after seed-prompts.ts learns to ask for a spoken version or to write for a
 * reading band. Every row simplified with the old text then silently lacks
 * whatever the new one asks for (audioScript is NULL, for instance).
 *
 * The rule is strict on purpose: a stored prompt is replaced ONLY when it is,
 * byte for byte, a text this project once shipped (seed-prompts-retired.ts).
 * A prompt an editor has changed by a single character, or removed, is theirs
 * and is left exactly as it is. That makes the refresh safe to run on every
 * `npm run db:init`, which is where it runs.
 */
import type { Database } from 'better-sqlite3';
import { createSettingsRepository } from './repositories/settingsRepository.js';
import {
  GENERIC_SIMPLIFICATION_PROMPT, YOUNG_READERS_SIMPLIFICATION_PROMPT,
} from './seed-prompts.js';
import { RETIRED_GENERIC_PROMPTS, RETIRED_YOUNG_READERS_PROMPTS } from './seed-prompts-retired.js';

/** The band anchor the young-readers override is keyed under. */
export const YOUNG_READERS_KEY = '5';
/** Where the same override sat before reading bands existed. */
const PRE_BAND_YOUNG_READERS_KEY = '6';

/**
 * - `current`     already the seeded text; nothing to do.
 * - `refreshed`   was an untouched older seed and now carries the current one.
 * - `customised`  differs from every seed this project shipped; left alone.
 * - `absent`      no such override (an editor removed it, or it never existed); left alone.
 */
export type SeededPromptState = 'current' | 'refreshed' | 'customised' | 'absent';

export interface SeededPromptRefresh {
  generic: SeededPromptState;
  youngReaders: SeededPromptState;
}

const isRetired = (text: string, retired: readonly string[]) =>
  retired.some((seed) => seed.trim() === text.trim());

function classify(
  stored: string | undefined, seeded: string, retired: readonly string[],
): Exclude<SeededPromptState, 'refreshed'> | 'stale' {
  if (stored === undefined || !stored.trim()) return 'absent';
  if (stored.trim() === seeded.trim()) return 'current';
  return isRetired(stored, retired) ? 'stale' : 'customised';
}

/**
 * Replace each untouched older seed with the current one and say what was
 * found. Reads and writes through the settings repository, so the row's
 * updatedAt moves with it. A database with no prompt config row (fresh, never
 * seeded) is left for `npm run db:seed` and reported as absent on both counts.
 */
export function refreshSeededPrompts(db: Database, now: string = new Date().toISOString()): SeededPromptRefresh {
  const hasRow = db.prepare(`SELECT 1 FROM translation_prompt_config WHERE id = 'default'`).get();
  if (!hasRow) return { generic: 'absent', youngReaders: 'absent' };

  const settings = createSettingsRepository(db);
  const config = settings.getPromptConfig();
  const ageOverrides = { ...config.ageOverrides };

  const genericState = classify(config.genericPrompt, GENERIC_SIMPLIFICATION_PROMPT, RETIRED_GENERIC_PROMPTS);

  // The override is looked for at its current key first. A database from
  // before reading bands still holds it at '6'; when THAT is an untouched seed
  // it is moved to '5' as part of the refresh, which is where the age-band
  // migration would have re-keyed it anyway. A customised '6' is reported as
  // such and not touched — `npm run db:migrate-age-bands` re-keys it without
  // losing the text.
  let youngKey = YOUNG_READERS_KEY;
  let youngState = classify(
    ageOverrides[YOUNG_READERS_KEY], YOUNG_READERS_SIMPLIFICATION_PROMPT, RETIRED_YOUNG_READERS_PROMPTS,
  );
  if (youngState === 'absent' && ageOverrides[PRE_BAND_YOUNG_READERS_KEY] !== undefined) {
    youngKey = PRE_BAND_YOUNG_READERS_KEY;
    youngState = classify(
      ageOverrides[PRE_BAND_YOUNG_READERS_KEY], YOUNG_READERS_SIMPLIFICATION_PROMPT, RETIRED_YOUNG_READERS_PROMPTS,
    );
  }

  if (genericState !== 'stale' && youngState !== 'stale') {
    return { generic: genericState, youngReaders: youngState };
  }

  if (youngState === 'stale') {
    delete ageOverrides[youngKey];
    ageOverrides[YOUNG_READERS_KEY] = YOUNG_READERS_SIMPLIFICATION_PROMPT;
  }
  settings.savePromptConfig(
    {
      genericPrompt: genericState === 'stale' ? GENERIC_SIMPLIFICATION_PROMPT : config.genericPrompt,
      ageOverrides,
    },
    now,
  );

  return {
    generic: genericState === 'stale' ? 'refreshed' : genericState,
    youngReaders: youngState === 'stale' ? 'refreshed' : youngState,
  };
}
