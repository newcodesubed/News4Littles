/**
 * refreshSeededPrompts — carrying an improved seeded prompt to a database that
 * was seeded with an older one.
 *
 * The rules that matter: a stored prompt that is exactly an older seed becomes
 * the current seed; a prompt an editor changed, by however little, or removed,
 * is never touched; an untouched pre-band override at '6' is moved to '5'; and
 * `npm run db:init` performs the refresh, so nobody has to know the script.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { initialiseSchema } from '../src/db/init.js';
import { refreshSeededPrompts } from '../src/db/refreshSeededPrompts.js';
import { createSettingsRepository } from '../src/db/repositories/settingsRepository.js';
import {
  GENERIC_SIMPLIFICATION_PROMPT, YOUNG_READERS_SIMPLIFICATION_PROMPT,
} from '../src/db/seed-prompts.js';
import {
  GENERIC_PROMPT_V2, GENERIC_PROMPT_V3, RETIRED_GENERIC_PROMPTS, RETIRED_YOUNG_READERS_PROMPTS,
  YOUNG_READERS_PROMPT_V2, YOUNG_READERS_PROMPT_V3,
} from '../src/db/seed-prompts-retired.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

const settings = () => createSettingsRepository(ctx.db);

/** Put the database in the state an older seed would have left it. */
function storePrompts(genericPrompt: string, ageOverrides: Record<string, string>) {
  settings().savePromptConfig({ genericPrompt, ageOverrides }, '2026-09-07T11:10:58.486Z');
}

describe('refreshSeededPrompts', () => {
  it('leaves a freshly seeded database alone', () => {
    const before = settings().getPromptConfig();

    expect(refreshSeededPrompts(ctx.db)).toEqual({ generic: 'current', youngReaders: 'current' });
    expect(settings().getPromptConfig()).toEqual(before);
  });

  it('replaces the band-era seed that never asked for a spoken version', () => {
    // The state of a database seeded between reading bands and the audio
    // script: audioScript comes back NULL from every simplification because the
    // model was never asked for one.
    storePrompts(GENERIC_PROMPT_V3, { '5': YOUNG_READERS_PROMPT_V3 });
    expect(GENERIC_PROMPT_V3).not.toContain('audioScript');

    const report = refreshSeededPrompts(ctx.db, '2026-09-16T12:00:00.000Z');

    expect(report).toEqual({ generic: 'refreshed', youngReaders: 'refreshed' });
    const config = settings().getPromptConfig();
    expect(config.genericPrompt).toBe(GENERIC_SIMPLIFICATION_PROMPT);
    expect(config.ageOverrides).toEqual({ '5': YOUNG_READERS_SIMPLIFICATION_PROMPT });
    expect(config.genericPrompt).toContain('"audioScript"');
    expect(config.updatedAt).toBe('2026-09-16T12:00:00.000Z');
  });

  it('replaces the pre-band seed and moves its override from 6 to 5', () => {
    storePrompts(GENERIC_PROMPT_V2, { '6': YOUNG_READERS_PROMPT_V2 });

    expect(refreshSeededPrompts(ctx.db)).toEqual({ generic: 'refreshed', youngReaders: 'refreshed' });
    expect(settings().getPromptConfig().ageOverrides).toEqual({
      '5': YOUNG_READERS_SIMPLIFICATION_PROMPT,
    });
  });

  it('recognises every retired seed, however old', () => {
    for (const generic of RETIRED_GENERIC_PROMPTS) {
      storePrompts(generic, {});
      expect(refreshSeededPrompts(ctx.db).generic).toBe('refreshed');
    }
    for (const young of RETIRED_YOUNG_READERS_PROMPTS) {
      storePrompts(GENERIC_SIMPLIFICATION_PROMPT, { '5': young });
      expect(refreshSeededPrompts(ctx.db).youngReaders).toBe('refreshed');
    }
  });

  it('never touches a prompt an editor has changed, however slightly', () => {
    const edited = GENERIC_PROMPT_V3.replace('Write calmly.', 'Write calmly and kindly.');
    const editedYoung = `${YOUNG_READERS_PROMPT_V3}\n- Mention the weather.`;
    storePrompts(edited, { '5': editedYoung });
    const before = settings().getPromptConfig();

    expect(refreshSeededPrompts(ctx.db)).toEqual({ generic: 'customised', youngReaders: 'customised' });
    expect(settings().getPromptConfig()).toEqual(before);
  });

  it('does not re-add an override an editor removed', () => {
    storePrompts(GENERIC_PROMPT_V3, {});

    expect(refreshSeededPrompts(ctx.db)).toEqual({ generic: 'refreshed', youngReaders: 'absent' });
    expect(settings().getPromptConfig().ageOverrides).toEqual({});
  });

  it('refreshes one prompt without disturbing a customised other', () => {
    storePrompts(GENERIC_PROMPT_V3, { '5': 'My own words for little ones.', '11': 'Teen prompt.' });

    expect(refreshSeededPrompts(ctx.db)).toEqual({ generic: 'refreshed', youngReaders: 'customised' });
    const config = settings().getPromptConfig();
    expect(config.genericPrompt).toBe(GENERIC_SIMPLIFICATION_PROMPT);
    expect(config.ageOverrides).toEqual({ '5': 'My own words for little ones.', '11': 'Teen prompt.' });
  });

  it('leaves a customised pre-band override at 6 for the age-band migration', () => {
    storePrompts(GENERIC_SIMPLIFICATION_PROMPT, { '6': 'Edited for six-year-olds.' });

    expect(refreshSeededPrompts(ctx.db)).toEqual({ generic: 'current', youngReaders: 'customised' });
    expect(settings().getPromptConfig().ageOverrides).toEqual({ '6': 'Edited for six-year-olds.' });
  });

  it('is a no-op on a database that has never been seeded', () => {
    ctx.db.prepare(`DELETE FROM translation_prompt_config`).run();

    expect(refreshSeededPrompts(ctx.db)).toEqual({ generic: 'absent', youngReaders: 'absent' });
    expect(ctx.db.prepare(`SELECT count(*) AS n FROM translation_prompt_config`).get()).toEqual({ n: 0 });
  });

  it('runs as part of npm run db:init', () => {
    storePrompts(GENERIC_PROMPT_V3, { '5': YOUNG_READERS_PROMPT_V3 });

    // better-sqlite3 exposes the file it opened as `name`.
    initialiseSchema(ctx.db.name);

    const db = openDatabase(ctx.db.name);
    try {
      const config = createSettingsRepository(db).getPromptConfig();
      expect(config.genericPrompt).toBe(GENERIC_SIMPLIFICATION_PROMPT);
      expect(config.ageOverrides).toEqual({ '5': YOUNG_READERS_SIMPLIFICATION_PROMPT });
    } finally {
      db.close();
    }
  });
});
