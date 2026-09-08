/**
 * Drafts and version history for the prompt sandbox — PRD §7.4, §7.5.
 *
 * Finally uses the prompt_drafts and prompt_versions tables created in the
 * first phase. Both are keyed on target + age where age may be NULL, so both
 * rely on the COALESCE(age, -1) unique index: SQLite treats NULLs as distinct,
 * which would otherwise allow unlimited duplicate generic rows.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export const PROMPT_TARGETS = ['simplification', 'guard'] as const;
export type PromptTarget = (typeof PROMPT_TARGETS)[number];

/** §8.6. No id: the natural key is target + age. */
export interface PromptDraft {
  target: PromptTarget;
  age: number | null;
  promptText: string;
  updatedAt: string;
}

/** §7.5. Immutable: one row per promotion, never updated or deleted. */
export interface PromptVersion {
  id: string;
  target: PromptTarget;
  age: number | null;
  promptText: string;
  version: number;
  promotedBy: string;
  promotedAt: string;
  note: string | null;
}

export interface PromptRepository {
  listDrafts(): PromptDraft[];
  findDraft(target: PromptTarget, age: number | null): PromptDraft | undefined;
  saveDraft(draft: Omit<PromptDraft, 'updatedAt'>, now: string): void;
  deleteDraft(target: PromptTarget, age: number | null): void;
  listVersions(filter?: { target?: PromptTarget; age?: number | null }): PromptVersion[];
  /** The version a new promotion would take: one more than the highest so far. */
  nextVersion(target: PromptTarget, age: number | null): number;
  /** Appends an immutable version record and returns it. */
  recordPromotion(input: Omit<PromptVersion, 'id' | 'version' | 'promotedAt'>, now: string): PromptVersion;
  /** Current version number per target+age, for the settings summary (§7.5). */
  currentVersions(): Record<string, number>;
}

/** The key shape used by translation_prompt_config.versions. */
export function versionKey(target: PromptTarget, age: number | null): string {
  return age === null ? target : `${target}:${age}`;
}

export function createPromptRepository(db: Database): PromptRepository {
  const statements = {
    listDrafts: db.prepare(
      `SELECT target, age, promptText, updatedAt FROM prompt_drafts
       ORDER BY target, COALESCE(age, -1)`,
    ),
    findDraft: db.prepare(
      `SELECT target, age, promptText, updatedAt FROM prompt_drafts
       WHERE target = ? AND COALESCE(age, -1) = COALESCE(?, -1)`,
    ),
    // Requires the COALESCE expression index from schema.sql.
    saveDraft: db.prepare(
      `INSERT INTO prompt_drafts (target, age, promptText, updatedAt)
       VALUES (@target, @age, @promptText, @updatedAt)
       ON CONFLICT (target, COALESCE(age, -1))
       DO UPDATE SET promptText = excluded.promptText, updatedAt = excluded.updatedAt`,
    ),
    deleteDraft: db.prepare(
      `DELETE FROM prompt_drafts WHERE target = ? AND COALESCE(age, -1) = COALESCE(?, -1)`,
    ),
    maxVersion: db.prepare(
      `SELECT MAX(version) FROM prompt_versions
       WHERE target = ? AND COALESCE(age, -1) = COALESCE(?, -1)`,
    ),
    insertVersion: db.prepare(
      `INSERT INTO prompt_versions (id, target, age, promptText, version, promotedBy, promotedAt, note)
       VALUES (@id, @target, @age, @promptText, @version, @promotedBy, @promotedAt, @note)`,
    ),
    currentVersions: db.prepare(
      `SELECT target, age, MAX(version) AS version FROM prompt_versions
       GROUP BY target, COALESCE(age, -1)`,
    ),
  };

  return {
    listDrafts: () => statements.listDrafts.all() as PromptDraft[],

    findDraft: (target, age) =>
      statements.findDraft.get(target, age) as PromptDraft | undefined,

    saveDraft: (draft, now) =>
      void statements.saveDraft.run({ ...draft, updatedAt: now }),

    deleteDraft: (target, age) => void statements.deleteDraft.run(target, age),

    listVersions(filter = {}) {
      const where: string[] = [];
      const params: (string | number | null)[] = [];

      if (filter.target) {
        where.push('target = ?');
        params.push(filter.target);
      }
      if (filter.age !== undefined) {
        where.push('COALESCE(age, -1) = COALESCE(?, -1)');
        params.push(filter.age);
      }

      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      return db
        .prepare(`SELECT * FROM prompt_versions ${clause} ORDER BY promotedAt DESC, version DESC`)
        .all(...params) as PromptVersion[];
    },

    nextVersion: (target, age) =>
      ((statements.maxVersion.pluck().get(target, age) as number | null) ?? 0) + 1,

    recordPromotion(input, now) {
      const record: PromptVersion = {
        ...input,
        id: randomUUID(),
        version: this.nextVersion(input.target, input.age),
        promotedAt: now,
      };
      statements.insertVersion.run(record);
      return record;
    },

    currentVersions() {
      const rows = statements.currentVersions.all() as
        { target: PromptTarget; age: number | null; version: number }[];
      return Object.fromEntries(rows.map((row) => [versionKey(row.target, row.age), row.version]));
    },
  };
}
