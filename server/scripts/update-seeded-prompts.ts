/**
 * Upgrade the stored translation prompts to the current seeded text.
 *
 *   npm run db:update-prompts
 *
 * `npm run db:seed` is deliberately ON CONFLICT DO NOTHING so it can never
 * overwrite an editor's work, which means an improved seeded prompt would never
 * reach an existing database. This does that one job, and refuses to touch a
 * prompt that has been customised.
 *
 * Overrides are keyed by reading band (its youngest age). A database from
 * before bands existed keys its override at '6'; `npm run db:migrate-age-bands`
 * moves it to '5' — run that first, or this script seeds a fresh '5' and the
 * migration then reports the '6' it had to drop.
 */
import { openDatabase, DATABASE_PATH } from '../src/db/connection.js';
import { createSettingsRepository } from '../src/db/repositories/settingsRepository.js';
import {
  GENERIC_SIMPLIFICATION_PROMPT, YOUNG_READERS_SIMPLIFICATION_PROMPT,
} from '../src/db/seed-prompts.js';

/** The band the young-readers override is keyed under. */
const YOUNG_READERS_KEY = '5';

type State = 'already-current' | 'superseded' | 'customised' | 'empty';

/**
 * Opening lines of every seeded text this project has shipped, so an untouched
 * older seed is recognised as "ours, just out of date" rather than as an
 * editor's work. Add a line here whenever a seeded prompt's first line changes.
 */
const PREVIOUS_OPENINGS = {
  generic: [
    'You are rewriting a real news story for a {{age}}-year-old child.',
  ],
  youngReaders: [
    'You are rewriting a real news story for a 6-year-old child who is just learning to read.',
  ],
};

/**
 * "Still our seeded prompt" is decided by exact text, and "an older seed" by
 * the opening line. An earlier version of this script keyed off a marker
 * phrase inside the field notes, which survives across seed versions and so
 * declared stale prompts current.
 */
function classify(stored: string, seeded: string, previousOpenings: string[]): State {
  const text = stored.trim();
  if (!text) return 'empty';
  if (text === seeded.trim()) return 'already-current';

  const openings = [seeded.split('\n', 1)[0]!.trim(), ...previousOpenings];
  return openings.some((line) => text.startsWith(line)) ? 'superseded' : 'customised';
}

const db = openDatabase();

try {
  const settings = createSettingsRepository(db);
  const config = settings.getPromptConfig();

  const genericState = classify(
    config.genericPrompt, GENERIC_SIMPLIFICATION_PROMPT, PREVIOUS_OPENINGS.generic,
  );
  const youngState = classify(
    config.ageOverrides[YOUNG_READERS_KEY] ?? '',
    YOUNG_READERS_SIMPLIFICATION_PROMPT,
    PREVIOUS_OPENINGS.youngReaders,
  );

  console.log(`Database: ${DATABASE_PATH}\n`);
  console.log(`  generic prompt        ${genericState}`);
  console.log(`  ages 5-7 override     ${youngState}`);
  if (config.ageOverrides['6'] !== undefined) {
    console.log("  age-6 override        present — pre-band key; run npm run db:migrate-age-bands");
  }

  const updatable: State[] = ['superseded', 'empty'];
  const ageOverrides = { ...config.ageOverrides };

  let changed = false;
  if (updatable.includes(genericState)) changed = true;
  if (updatable.includes(youngState)) {
    ageOverrides[YOUNG_READERS_KEY] = YOUNG_READERS_SIMPLIFICATION_PROMPT;
    changed = true;
  }

  if (!changed) {
    console.log('\nNothing to do.');
    if (genericState === 'customised' || youngState === 'customised') {
      console.log('A customised prompt was left untouched. To adopt the current wording,');
      console.log('edit it in /admin/settings — the seeded text is in src/db/seed-prompts.ts.');
    }
  } else {
    settings.savePromptConfig(
      {
        genericPrompt: updatable.includes(genericState)
          ? GENERIC_SIMPLIFICATION_PROMPT
          : config.genericPrompt,
        ageOverrides,
      },
      new Date().toISOString(),
    );
    console.log('\nUpdated. The new wording applies to the next simplification.');
  }
} finally {
  db.close();
}
