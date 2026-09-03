/**
 * Seeds the reference data the app needs to boot: sources, guard config, app
 * settings, translation prompts and the admin account. PRD §5.1, §6.1, §3.6,
 * §5.3, §4.1.
 *
 * Deliberately seeds NO articles — raw_articles and kid_articles fill up from
 * the BBC scraper (§5.2) or the editor portal (§4.3).
 *
 * Idempotent: every insert is ON CONFLICT DO NOTHING, so re-running will not
 * overwrite edits made through the admin UI. To reset a row, delete it first.
 *
 *   npm run db:seed
 *
 * The admin credentials come from .env (see .env.example).
 */
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { ADMIN_PASSWORD, ADMIN_USERNAME } from '../env.js';
import { DATABASE_PATH, openDatabase } from './connection.js';
import { initialiseSchema } from './init.js';
import { AGE_6_SIMPLIFICATION_PROMPT, GENERIC_SIMPLIFICATION_PROMPT } from './seed-prompts.js';

const BCRYPT_ROUNDS = 10;

/**
 * PRD §5.1 prototype list, plus the 'manual' row that editor submissions (§4.3)
 * point at so raw_articles.sourceId is always a real foreign key.
 *
 * Only BBC carries a live feed URL: §5.2 names it the first production source
 * and it is the only URL the PRD actually specifies. The other four are seeded
 * disabled with a blank url so the first scraper run is honest rather than
 * half-broken — fill in a real feed URL in /admin/settings, then enable.
 * (This is why reuters/ap-news/npr are enabled = 0 here despite §5.1 listing
 * them as enabled; CNN is disabled in §5.1 too.)
 */
const SOURCES = [
  { id: 'bbc',     name: 'BBC News',           url: 'https://feeds.bbci.co.uk/news/rss.xml', enabled: 1, trustLevel: 'high',   parser: 'rss' },
  { id: 'reuters', name: 'Reuters',            url: '',                                      enabled: 0, trustLevel: 'high',   parser: 'rss' },
  { id: 'ap-news', name: 'Associated Press',   url: '',                                      enabled: 0, trustLevel: 'high',   parser: 'rss' },
  { id: 'npr',     name: 'NPR',                url: '',                                      enabled: 0, trustLevel: 'high',   parser: 'rss' },
  { id: 'cnn',     name: 'CNN',                url: '',                                      enabled: 0, trustLevel: 'medium', parser: 'rss' },
  { id: 'manual',  name: 'Manual submission',  url: '',                                      enabled: 0, trustLevel: 'high',   parser: null },
] as const;

/** PRD §6.1 default deny-list, verbatim. */
const DENY_LIST = [
  'war', 'killed', 'death', 'shooting', 'attack', 'bomb',
  'disaster', 'earthquake', 'violence', 'conflict', 'wounded',
];

export interface SeedResult {
  inserted: Record<string, number>;
  skipped: Record<string, number>;
}

export function seed(path: string = DATABASE_PATH): SeedResult {
  initialiseSchema(path);
  const db = openDatabase(path);

  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const record = (table: string, changes: number) => {
    if (changes > 0) inserted[table] = (inserted[table] ?? 0) + changes;
    else skipped[table] = (skipped[table] ?? 0) + 1;
  };

  const now = new Date().toISOString();

  // §4.1 documents admin/admin123 as the default, configurable via .env.
  // Only the bcrypt hash is stored, and it is computed here rather than
  // committed, so no credential material lives in the repo (§13.2).
  const username = ADMIN_USERNAME;
  const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  const run = db.transaction(() => {
    const insertSource = db.prepare(
      `INSERT INTO sources (id, name, url, enabled, trustLevel, parser, createdAt, updatedAt)
       VALUES (@id, @name, @url, @enabled, @trustLevel, @parser, @now, @now)
       ON CONFLICT (id) DO NOTHING`,
    );
    for (const source of SOURCES) record('sources', insertSource.run({ ...source, now }).changes);

    record('guard_config', db.prepare(
      `INSERT INTO guard_config
         (id, denyListEnabled, denyList, promptGuardEnabled, promptGuardText, updatedAt)
       VALUES ('default', 1, @denyList, 0, '', @now)
       ON CONFLICT (id) DO NOTHING`,
      // promptGuardEnabled = 0 and empty promptGuardText: the LLM guard (§6.2)
      // cannot run until an API key is configured (§13.2), so it starts off.
    ).run({ denyList: JSON.stringify(DENY_LIST), now }).changes);

    record('translation_prompt_config', db.prepare(
      `INSERT INTO translation_prompt_config
         (id, genericPrompt, ageOverrides, versions, updatedAt)
       VALUES ('default', @genericPrompt, @ageOverrides, '{}', @now)
       ON CONFLICT (id) DO NOTHING`,
    ).run({
      genericPrompt: GENERIC_SIMPLIFICATION_PROMPT,
      // Record<string, string>: age -> complete replacement prompt.
      // Age 6 is seeded because it is the default reading age (§3.6) and it
      // demonstrates the override mechanism for the sandbox.
      ageOverrides: JSON.stringify({ '6': AGE_6_SIMPLIFICATION_PROMPT }),
      // versions stays '{}': nothing has been promoted through the sandbox yet,
      // so there are no PromptVersion records to count. Key convention for
      // later code: 'guard', 'simplification', 'simplification:6'.
      now,
    }).changes);

    record('app_settings', db.prepare(
      `INSERT INTO app_settings (id, defaultAge, scrapeTimes, llmProvider)
       VALUES ('default', 6, '["06:00"]', NULL)
       ON CONFLICT (id) DO NOTHING`,
      // defaultAge 6 per §3.6; scrapeTimes ["06:00"] per §5.3;
      // llmProvider NULL until a key is supplied (§13.2) — the local fallback
      // (§9.2) runs in the meantime.
    ).run().changes);

    record('admin_users', db.prepare(
      `INSERT INTO admin_users (username, passwordHash) VALUES (@username, @passwordHash)
       ON CONFLICT (username) DO NOTHING`,
    ).run({ username, passwordHash }).changes);
  });

  try {
    run();
    return { inserted, skipped };
  } finally {
    db.close();
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const { inserted, skipped } = seed();
  console.log(`Seeded ${DATABASE_PATH}`);

  const tables = [...new Set([...Object.keys(inserted), ...Object.keys(skipped)])].sort();
  for (const table of tables) {
    const parts = [];
    if (inserted[table]) parts.push(`${inserted[table]} inserted`);
    if (skipped[table]) parts.push(`${skipped[table]} already present`);
    console.log(`  ${table.padEnd(26)} ${parts.join(', ')}`);
  }
  console.log('\nNo articles seeded — those come from the scraper (§5.2) or the editor portal (§4.3).');
}
