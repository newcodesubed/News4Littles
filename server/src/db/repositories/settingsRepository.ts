/**
 * The three singleton config tables: guard_config (§6),
 * translation_prompt_config (§8.5) and app_settings (§8.7).
 *
 * Each is one row pinned to id 'default', so there is no "find" — only read
 * and write.
 */
import type { Database } from 'better-sqlite3';
import { NotFoundError } from '../../core/errors.js';

export interface GuardConfig {
  denyList: string[];
  denyListEnabled: boolean;
  promptGuardEnabled: boolean;
  promptGuardText: string;
  updatedAt: string;
}

export interface PromptConfig {
  genericPrompt: string;
  ageOverrides: Record<string, string>;
  versions: Record<string, number>;
  updatedAt: string;
}

export interface AppSettings {
  defaultAge: number;
  scrapeTimes: string[];
  llmProvider: string | null;
}

/** A JSON column that survives a corrupt value rather than throwing. */
function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export interface SettingsRepository {
  getGuardConfig(): GuardConfig;
  saveGuardConfig(config: Omit<GuardConfig, 'updatedAt'>, now: string): void;
  getPromptConfig(): PromptConfig;
  /** `versions` is deliberately not writable: §7.5 makes it a promotion counter. */
  savePromptConfig(config: Pick<PromptConfig, 'genericPrompt' | 'ageOverrides'>, now: string): void;
  getAppSettings(): AppSettings;
  saveAppSettings(settings: AppSettings): void;
}

export function createSettingsRepository(db: Database): SettingsRepository {
  const read = (table: string, what: string) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = 'default'`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new NotFoundError(`${what} missing. Run npm run db:seed.`);
    return row;
  };

  return {
    getGuardConfig() {
      const row = read('guard_config', 'Guard config');
      return {
        denyList: parseJson<string[]>(row.denyList, []),
        denyListEnabled: row.denyListEnabled === 1,
        promptGuardEnabled: row.promptGuardEnabled === 1,
        promptGuardText: String(row.promptGuardText ?? ''),
        updatedAt: String(row.updatedAt),
      };
    },

    saveGuardConfig(config, now) {
      db.prepare(
        `UPDATE guard_config SET denyList = @denyList, denyListEnabled = @denyListEnabled,
           promptGuardEnabled = @promptGuardEnabled, promptGuardText = @promptGuardText,
           updatedAt = @updatedAt
         WHERE id = 'default'`,
      ).run({
        denyList: JSON.stringify(config.denyList),
        denyListEnabled: config.denyListEnabled ? 1 : 0,
        promptGuardEnabled: config.promptGuardEnabled ? 1 : 0,
        promptGuardText: config.promptGuardText,
        updatedAt: now,
      });
    },

    getPromptConfig() {
      const row = read('translation_prompt_config', 'Prompt config');
      return {
        genericPrompt: String(row.genericPrompt ?? ''),
        ageOverrides: parseJson<Record<string, string>>(row.ageOverrides, {}),
        versions: parseJson<Record<string, number>>(row.versions, {}),
        updatedAt: String(row.updatedAt),
      };
    },

    savePromptConfig(config, now) {
      db.prepare(
        `UPDATE translation_prompt_config SET genericPrompt = @genericPrompt,
           ageOverrides = @ageOverrides, updatedAt = @updatedAt
         WHERE id = 'default'`,
      ).run({
        genericPrompt: config.genericPrompt,
        ageOverrides: JSON.stringify(config.ageOverrides),
        updatedAt: now,
      });
    },

    getAppSettings() {
      const row = read('app_settings', 'App settings');
      return {
        defaultAge: Number(row.defaultAge),
        scrapeTimes: parseJson<string[]>(row.scrapeTimes, []),
        llmProvider: row.llmProvider === null ? null : String(row.llmProvider),
      };
    },

    saveAppSettings(settings) {
      db.prepare(
        `UPDATE app_settings SET defaultAge = @defaultAge, scrapeTimes = @scrapeTimes,
           llmProvider = @llmProvider
         WHERE id = 'default'`,
      ).run({
        defaultAge: settings.defaultAge,
        scrapeTimes: JSON.stringify(settings.scrapeTimes),
        llmProvider: settings.llmProvider,
      });
    },
  };
}
