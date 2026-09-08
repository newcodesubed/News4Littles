/** All SQL touching sources (PRD §5.1). */
import type { Database } from 'better-sqlite3';

export const TRUST_LEVELS = ['high', 'medium', 'low'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export interface SourceRow {
  id: string;
  name: string;
  url: string;
  enabled: number;
  trustLevel: TrustLevel;
  parser: string | null;
  lastFetchedAt: string | null;
  lastFetchedItemPublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What the API returns: `enabled` as a real boolean, plus a usage count. */
export interface Source extends Omit<SourceRow, 'enabled'> {
  enabled: boolean;
  articleCount: number;
}

export interface NewSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  trustLevel: TrustLevel;
  parser: string | null;
}

export interface SourceRepository {
  listWithCounts(): Source[];
  findById(id: string): SourceRow | undefined;
  exists(id: string): boolean;
  listEnabled(): SourceRow[];
  insert(source: NewSource, now: string): void;
  update(id: string, changes: Record<string, string | number | null>, now: string): void;
  remove(id: string): void;
  /** §5.2 step 5: advance the incremental-scrape cursor. */
  recordFetch(id: string, fetchedAt: string, newestItemPublishedAt: string | null): void;
  clearCursor(id: string, now: string): void;
}

export function createSourceRepository(db: Database): SourceRepository {
  const statements = {
    listWithCounts: db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM raw_articles r WHERE r.sourceId = s.id) AS articleCount
      FROM sources s ORDER BY s.name`),
    byId: db.prepare(`SELECT * FROM sources WHERE id = ?`),
    exists: db.prepare(`SELECT 1 FROM sources WHERE id = ?`),
    enabled: db.prepare(
      `SELECT * FROM sources WHERE enabled = 1 AND url <> '' ORDER BY id`,
    ),
    insert: db.prepare(
      `INSERT INTO sources (id, name, url, enabled, trustLevel, parser, createdAt, updatedAt)
       VALUES (@id, @name, @url, @enabled, @trustLevel, @parser, @now, @now)`,
    ),
    remove: db.prepare(`DELETE FROM sources WHERE id = ?`),
    recordFetch: db.prepare(
      `UPDATE sources SET lastFetchedAt = @fetchedAt, lastFetchedItemPublishedAt = @newest,
         updatedAt = @fetchedAt WHERE id = @id`,
    ),
    clearCursor: db.prepare(
      `UPDATE sources SET lastFetchedAt = NULL, lastFetchedItemPublishedAt = NULL, updatedAt = ?
       WHERE id = ?`,
    ),
  };

  return {
    listWithCounts: () =>
      (statements.listWithCounts.all() as (SourceRow & { articleCount: number })[]).map((row) => ({
        ...row,
        enabled: row.enabled === 1,
      })),

    findById: (id) => statements.byId.get(id) as SourceRow | undefined,
    exists: (id) => statements.exists.get(id) !== undefined,
    listEnabled: () => statements.enabled.all() as SourceRow[],

    insert: (source, now) =>
      void statements.insert.run({ ...source, enabled: source.enabled ? 1 : 0, now }),

    update(id, changes, now) {
      const sets = Object.keys(changes).map((column) => `${column} = @${column}`);
      sets.push('updatedAt = @updatedAt');
      db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = @id`)
        .run({ ...changes, id, updatedAt: now });
    },

    remove: (id) => void statements.remove.run(id),
    recordFetch: (id, fetchedAt, newest) => void statements.recordFetch.run({ id, fetchedAt, newest }),
    clearCursor: (id, now) => void statements.clearCursor.run(now, id),
  };
}
