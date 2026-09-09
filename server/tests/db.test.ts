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

  it('migrates a v2 database: adds the new columns and backfills simplifiedAt', () => {
    // A v2-shaped database: the two tables this migration touches, minus the
    // v3 columns, with a row already in them.
    const old = openDatabase(path);
    old.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, trustLevel TEXT NOT NULL, parser TEXT,
        lastFetchedAt TEXT, lastFetchedItemPublishedAt TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE raw_articles (
        id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES sources (id),
        sourceName TEXT NOT NULL, sourceUrl TEXT NOT NULL, url TEXT NOT NULL,
        headline TEXT NOT NULL, body TEXT NOT NULL, topic TEXT NOT NULL,
        publishedAt TEXT, fetchedAt TEXT NOT NULL);
      INSERT INTO sources VALUES
        ('bbc', 'BBC News', 'https://feed', 1, 'high', NULL, NULL, NULL,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO raw_articles VALUES
        ('r1', 'bbc', 'BBC News', 'https://feed', 'https://example.com/1',
         'Adult headline', 'Body text', 'World', NULL, '2026-09-01T00:00:00.000Z');
    `);
    old.pragma('user_version = 2');
    old.close();

    initialiseSchema(path);

    const db = openDatabase(path);
    const columns = (table: string) =>
      (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(columns('raw_articles')).toContain('simplifiedAt');
    expect(columns('app_settings')).toContain('simplifyBudget');
    expect(columns('scrape_runs')).toEqual(expect.arrayContaining(['simplified', 'leftWaiting']));

    // Under v2 every stored raw was simplified the moment it was stored, so it
    // must NOT come out of the migration looking like a waiting article.
    expect(
      db.prepare(`SELECT simplifiedAt FROM raw_articles WHERE id = 'r1'`).pluck().get(),
    ).toBe('2026-09-01T00:00:00.000Z');
    db.close();
  });

  it('re-running db:init never stamps a waiting raw article as simplified', () => {
    // The backfill is correct exactly once, on the v2 -> v3 upgrade. If it ran
    // on every init it would erase the backlog this whole feature creates.
    initialiseSchema(path);
    seed(path);

    const db = openDatabase(path);
    db.prepare(
      `INSERT INTO raw_articles
         (id, sourceId, sourceName, sourceUrl, url, headline, body, topic,
          publishedAt, fetchedAt, simplifiedAt)
       VALUES ('waiting-1', 'bbc', 'BBC News', 'https://feed', 'https://example.com/w',
               'Waiting headline', 'Body', 'World', NULL, '2026-09-08T00:00:00.000Z', NULL)`,
    ).run();
    db.close();

    initialiseSchema(path);

    const after = openDatabase(path);
    expect(
      after.prepare(`SELECT simplifiedAt FROM raw_articles WHERE id = 'waiting-1'`).pluck().get(),
    ).toBeNull();
    after.close();
  });

  it('defaults the simplification budget to 10', () => {
    initialiseSchema(path);
    seed(path);
    const db = openDatabase(path);
    expect(
      db.prepare(`SELECT simplifyBudget FROM app_settings WHERE id = 'default'`).pluck().get(),
    ).toBe(10);
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
