/**
 * Upgrade the stored translation prompts to the current seeded text.
 *
 *   npm run db:update-prompts
 *
 * `npm run db:seed` is deliberately ON CONFLICT DO NOTHING so it can never
 * overwrite an editor's work, which means an improved seeded prompt would never
 * reach an existing database. This does that one job, and refuses to touch a
 * prompt that has been customised.
 */
import { openDatabase, DATABASE_PATH } from '../src/db/connection.js';
import { createSettingsRepository } from '../src/db/repositories/settingsRepository.js';
import { AGE_6_SIMPLIFICATION_PROMPT, GENERIC_SIMPLIFICATION_PROMPT } from '../src/db/seed-prompts.js';

/** Present only in the current seeded text. */
const CURRENT_MARKER = 'Judge the SUBJECT of the story';

type State = 'already-current' | 'superseded' | 'customised' | 'empty';

/**
 * Recognising "this is still our seeded prompt" by its opening line rather than
 * by a marker inside the field notes. An earlier version of this script keyed
 * off a line that appears only in the generic prompt, so it silently declared
 * the age-6 override "customised" and left it on the old criteria — which
 * mattered, because 6 is the default reading age.
 */
function classify(stored: string, seeded: string): State {
  if (!stored.trim()) return 'empty';
  if (stored.includes(CURRENT_MARKER)) return 'already-current';

  const openingLine = seeded.split('\n', 1)[0]!.trim();
  return stored.trim().startsWith(openingLine) ? 'superseded' : 'customised';
}

const db = openDatabase();

try {
  const settings = createSettingsRepository(db);
  const config = settings.getPromptConfig();

  const genericState = classify(config.genericPrompt, GENERIC_SIMPLIFICATION_PROMPT);
  const age6State = classify(config.ageOverrides['6'] ?? '', AGE_6_SIMPLIFICATION_PROMPT);

  console.log(`Database: ${DATABASE_PATH}\n`);
  console.log(`  generic prompt   ${genericState}`);
  console.log(`  age-6 override   ${age6State}`);

  const updatable: State[] = ['superseded', 'empty'];
  const ageOverrides = { ...config.ageOverrides };

  let changed = false;
  if (updatable.includes(genericState)) changed = true;
  if (updatable.includes(age6State)) {
    ageOverrides['6'] = AGE_6_SIMPLIFICATION_PROMPT;
    changed = true;
  }

  if (!changed) {
    console.log('\nNothing to do.');
    if (genericState === 'customised' || age6State === 'customised') {
      console.log('A customised prompt was left untouched. To adopt the new safety criteria,');
      console.log('edit it in /admin/settings — the criteria are in src/db/seed-prompts.ts.');
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
    console.log('\nUpdated. The new safety criteria apply to the next simplification.');
  }
} finally {
  db.close();
}
