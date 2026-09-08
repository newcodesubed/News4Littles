/** Schema, seeding and row/API mapping — PRD §8. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { initialiseSchema, SCHEMA_VERSION } from '../src/db/init.js';
import { seed } from '../src/db/seed.js';
import { isArticleStatus, toKidArticle, type KidArticleRow } from '../src/core/article.js';
import { countRows } from './helpers.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'n4l-db-'));
  path = join(dir, 'test.db');
});
afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

describe('schema (§8)', () => {
  it('creates every table', () => {
    expect(initialiseSchema(path)).toEqual([
      'admin_users', 'app_settings', 'guard_config', 'kid_articles',
      'prompt_drafts', 'prompt_versions', 'raw_articles', 'scrape_runs', 'sources',
      'translation_prompt_config',
    ]);
  });

  it('adds a new table to an existing database without losing data', () => {
    // schema.sql is entirely CREATE ... IF NOT EXISTS, which is how a schema
    // addition reaches a database that already has rows in it.
    initialiseSchema(path);
    seed(path);
    const db = openDatabase(path);
    db.prepare(`DROP TABLE scrape_runs`).run();
    const sourcesBefore = countRows(db, 'sources');
    db.close();

    initialiseSchema(path);
    const after = openDatabase(path);
    expect(after.prepare(`SELECT 1 FROM sqlite_master WHERE name='scrape_runs'`).get()).toBeTruthy();
    expect(countRows(after, 'sources')).toBe(sourcesBefore);
    after.close();
  });

  it('is idempotent and preserves data', () => {
    initialiseSchema(path);
    seed(path);
    const before = (() => { const db = openDatabase(path); const n = countRows(db, 'sources'); db.close(); return n; })();

    initialiseSchema(path);
    const db = openDatabase(path);
    expect(countRows(db, 'sources')).toBe(before);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('enforces the safety and status unions', () => {
    initialiseSchema(path); seed(path);
    const db = openDatabase(path);
    db.prepare(`INSERT INTO raw_articles (id,sourceId,sourceName,sourceUrl,url,headline,body,topic,fetchedAt)
      VALUES ('r','bbc','BBC','u','u','h','b','World','2026-01-01T00:00:00Z')`).run();

    const insert = (safety: string, status: string, publishedAt: string | null) =>
      db.prepare(`INSERT INTO kid_articles (id,originalId,ageTarget,kidHeadline,summary,whatHappened,whyItMatters,
        vocab,thinkAbout,safety,category,readingMinutes,sourceName,sourceUrl,status,editedByHuman,createdAt,publishedAt)
        VALUES (?, 'r',8,'h','s','w','y','[]','t',?,'World',3,'BBC','u',?,0,'2026-01-01T00:00:00Z',?)`)
        .run(`k-${Math.random()}`, safety, status, publishedAt);

    expect(() => insert('scary', 'pending_review', null)).toThrow(/CHECK constraint/);
    expect(() => insert('calm', 'draft', null)).toThrow(/CHECK constraint/);
    expect(() => insert('calm', 'published', null)).toThrow(/CHECK constraint/);
    expect(() => insert('calm', 'published', '2026-01-01T00:00:00Z')).not.toThrow();
    db.close();
  });

  it('protects articles from a source deletion', () => {
    initialiseSchema(path); seed(path);
    const db = openDatabase(path);
    db.prepare(`INSERT INTO raw_articles (id,sourceId,sourceName,sourceUrl,url,headline,body,topic,fetchedAt)
      VALUES ('r','bbc','BBC','u','u','h','b','World','2026-01-01T00:00:00Z')`).run();
    expect(() => db.prepare(`DELETE FROM sources WHERE id='bbc'`).run()).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('allows only one row in each singleton table', () => {
    initialiseSchema(path); seed(path);
    const db = openDatabase(path);
    for (const table of ['guard_config', 'app_settings', 'translation_prompt_config']) {
      expect(() => db.prepare(`INSERT INTO ${table} (id) VALUES ('other')`).run()).toThrow();
    }
    db.close();
  });

  it('allows one prompt draft per target+age, NULL age included', () => {
    initialiseSchema(path);
    const db = openDatabase(path);
    const draft = (target: string, age: number | null) =>
      db.prepare(`INSERT INTO prompt_drafts (target,age,promptText,updatedAt) VALUES (?,?,'t','2026-01-01T00:00:00Z')`).run(target, age);

    expect(() => draft('simplification', null)).not.toThrow();
    expect(() => draft('simplification', null)).toThrow(/UNIQUE/);
    expect(() => draft('simplification', 8)).not.toThrow();
    expect(() => draft('guard', 8)).toThrow(/CHECK constraint/);
    db.close();
  });
});

describe('seeding', () => {
  it('inserts the reference rows', () => {
    initialiseSchema(path);
    const result = seed(path);
    expect(result.inserted).toMatchObject({ sources: 6, guard_config: 1, app_settings: 1, admin_users: 1 });
  });

  it('is idempotent and never overwrites an edit', () => {
    initialiseSchema(path);
    seed(path);

    const db = openDatabase(path);
    db.prepare(`UPDATE app_settings SET defaultAge = 11`).run();
    db.close();

    seed(path);
    const after = openDatabase(path);
    expect(after.prepare('SELECT defaultAge FROM app_settings').pluck().get()).toBe(11);
    expect(countRows(after, 'sources')).toBe(6);
    after.close();
  });

  it('creates the manual source that editor submissions attach to', () => {
    initialiseSchema(path); seed(path);
    const db = openDatabase(path);
    expect(db.prepare(`SELECT id FROM sources WHERE id='manual'`).pluck().get()).toBe('manual');
    db.close();
  });

  it('stores only a bcrypt hash for the admin account', () => {
    initialiseSchema(path); seed(path);
    const db = openDatabase(path);
    const hash = db.prepare(`SELECT passwordHash FROM admin_users`).pluck().get() as string;
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash).not.toContain('admin123');
    db.close();
  });
});

describe('row -> API mapping (§8.3)', () => {
  const row: KidArticleRow = {
    id: 'a', originalId: 'r', ageTarget: 8, kidHeadline: 'h', summary: 's',
    whatHappened: 'w', whyItMatters: 'y', vocab: '[{"word":"reef","definition":"d"}]',
    thinkAbout: 't', feelingNote: null, safety: 'calm', contentWarnings: null,
    category: 'World', readingMinutes: 3, sourceName: 'BBC', sourceUrl: 'u',
    status: 'pending_review', rejectReason: null, editedByHuman: 0,
    createdAt: '2026-01-01T00:00:00Z', publishedAt: null,
  };

  it('parses JSON columns and converts 0/1 to booleans', () => {
    const article = toKidArticle(row);
    expect(article.vocab).toEqual([{ word: 'reef', definition: 'd' }]);
    expect(article.editedByHuman).toBe(false);
    expect(article.contentWarnings).toBeNull();
  });

  it('parses contentWarnings when present', () => {
    expect(toKidArticle({ ...row, contentWarnings: '["war"]' }).contentWarnings).toEqual(['war']);
  });

  it('recognises the three valid statuses and nothing else', () => {
    for (const s of ['pending_review', 'published', 'rejected']) expect(isArticleStatus(s)).toBe(true);
    for (const s of ['draft', '', 'PUBLISHED']) expect(isArticleStatus(s)).toBe(false);
  });
});
