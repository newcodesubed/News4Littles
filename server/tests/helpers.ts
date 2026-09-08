/**
 * Test scaffolding: every suite gets its own throwaway SQLite file and its own
 * HTTP server on an ephemeral port, so no test can see another's writes and
 * none of them touch the developer's real database.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { initialiseSchema } from '../src/db/init.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/server.js';

export const ADMIN_AUTH = `Basic ${Buffer.from('admin:admin123').toString('base64')}`;

export interface TestContext {
  db: Database;
  base: string;
  /** Authenticated request against the test server. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** Same, but without credentials. */
  anon: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
}

/**
 * A seeded database plus a running app. `seedData` controls whether the
 * reference rows (sources, guard config, admin user) are inserted.
 */
export function createTestContext(options: { seedData?: boolean } = {}): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'n4l-test-'));
  const path = join(dir, 'test.db');

  initialiseSchema(path);
  if (options.seedData !== false) seed(path);

  const db = openDatabase(path);
  const server: Server = createApp(db).listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const request = (auth: boolean) => (p: string, init: RequestInit = {}) =>
    fetch(base + p, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: ADMIN_AUTH } : {}),
        ...(init.headers ?? {}),
      },
    });

  return {
    db,
    base,
    api: request(true),
    anon: request(false),
    close: () => {
      server.close();
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

let fixtureCount = 0;

/** Insert a raw article and return its id. */
export function insertRawArticle(
  db: Database,
  overrides: Partial<{
    id: string; sourceId: string; sourceName: string; sourceUrl: string; url: string;
    headline: string; body: string; topic: string; publishedAt: string | null; fetchedAt: string;
  }> = {},
): string {
  const id = overrides.id ?? `raw-${++fixtureCount}`;
  const now = '2026-09-04T09:00:00.000Z';

  db.prepare(
    `INSERT INTO raw_articles (id, sourceId, sourceName, sourceUrl, url, headline, body, topic, publishedAt, fetchedAt)
     VALUES (@id, @sourceId, @sourceName, @sourceUrl, @url, @headline, @body, @topic, @publishedAt, @fetchedAt)`,
  ).run({
    id,
    sourceId: 'bbc',
    sourceName: 'BBC News',
    sourceUrl: 'https://www.bbc.co.uk/news',
    url: `https://example.com/${id}`,
    headline: 'Original adult headline about a reef',
    body: 'A rover surveyed the reef today. The water was clear.',
    topic: 'World',
    publishedAt: now,
    fetchedAt: now,
    ...overrides,
  });

  return id;
}

/** Insert a kid article (creating a raw parent unless one is given). */
export function insertKidArticle(
  db: Database,
  overrides: Partial<{
    id: string; originalId: string; ageTarget: number; kidHeadline: string; summary: string;
    whatHappened: string; whyItMatters: string; vocab: unknown[]; thinkAbout: string;
    feelingNote: string | null; safety: string; contentWarnings: string[] | null; category: string;
    readingMinutes: number; sourceName: string; sourceUrl: string; status: string;
    rejectReason: string | null; editedByHuman: boolean; createdAt: string; publishedAt: string | null;
  }> = {},
): string {
  const id = overrides.id ?? `kid-${++fixtureCount}`;
  const now = '2026-09-04T09:00:00.000Z';
  const status = overrides.status ?? 'pending_review';
  const safety = overrides.safety ?? 'calm';

  const row = {
    id,
    originalId: overrides.originalId ?? insertRawArticle(db),
    ageTarget: 8,
    kidHeadline: `Headline ${id}`,
    summary: 'A short summary.',
    whatHappened: 'What happened.',
    whyItMatters: 'Why it matters.',
    thinkAbout: 'Something to think about?',
    feelingNote: safety === 'calm' ? null : 'A gentle note.',
    category: 'World',
    readingMinutes: 3,
    sourceName: 'BBC News',
    sourceUrl: 'https://example.com/original',
    rejectReason: null,
    createdAt: now,
    ...overrides,
    safety,
    status,
    vocab: JSON.stringify(overrides.vocab ?? [{ word: 'reef', definition: 'A ridge under the sea.' }]),
    contentWarnings: overrides.contentWarnings ? JSON.stringify(overrides.contentWarnings) : null,
    editedByHuman: overrides.editedByHuman ? 1 : 0,
    // Honour the schema CHECK: published rows must carry publishedAt.
    publishedAt:
      overrides.publishedAt !== undefined
        ? overrides.publishedAt
        : status === 'published'
          ? now
          : null,
  };

  db.prepare(
    `INSERT INTO kid_articles
       (id, originalId, ageTarget, kidHeadline, summary, whatHappened, whyItMatters, vocab,
        thinkAbout, feelingNote, safety, contentWarnings, category, readingMinutes,
        sourceName, sourceUrl, status, rejectReason, editedByHuman, createdAt, publishedAt)
     VALUES
       (@id, @originalId, @ageTarget, @kidHeadline, @summary, @whatHappened, @whyItMatters, @vocab,
        @thinkAbout, @feelingNote, @safety, @contentWarnings, @category, @readingMinutes,
        @sourceName, @sourceUrl, @status, @rejectReason, @editedByHuman, @createdAt, @publishedAt)`,
  ).run(row);

  return id;
}

export const getKidArticle = (db: Database, id: string) =>
  db.prepare('SELECT * FROM kid_articles WHERE id = ?').get(id) as Record<string, unknown> | undefined;

export const countRows = (db: Database, table: string) =>
  db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
