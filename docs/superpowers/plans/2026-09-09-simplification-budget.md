# Simplification Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a scrape run from simplifying every article it finds — store them all as raw rows, spend a configurable budget of 10 LLM simplifications per run, and let an editor simplify the leftovers on demand from the review queue.

**Architecture:** Ingestion splits into two phases. Phase 1 (`rssScraper`) fetches every enabled source and stores every new item as a `raw_articles` row with `simplifiedAt = NULL`, advancing the incremental cursor as it does today. Phase 2 (`simplifyService`, driven by `scrapeService`) reads the waiting backlog, allocates the budget round-robin across sources newest-first, and simplifies exactly that batch — one article per transaction, so the batch is resumable. The same `simplifyRawArticles` engine backs a new "Not yet simplified" tab in the review queue, so the automatic and manual paths cannot drift apart.

**Tech Stack:** Node.js 20+, TypeScript (ESM, `.js` import specifiers), Express 4, better-sqlite3 with raw SQL and no ORM, Vitest on the server, React 18 + Vite + Tailwind + Testing Library on the web.

**Spec:** `docs/superpowers/specs/2026-09-09-simplification-budget-design.md`

## Global Constraints

- Column names in SQL are **verbatim from the PRD's TypeScript interfaces** (`kidHeadline`, `simplifiedAt`, `lastFetchedItemPublishedAt`) so rows map onto the API with no renaming layer. camelCase columns, snake_case table names.
- SQLite has no BOOLEAN/ARRAY/DATE. Booleans are `INTEGER 0/1 + CHECK (x IN (0,1))`, arrays/objects are `TEXT` holding JSON with a `json_valid()` CHECK, timestamps are `TEXT` ISO-8601.
- `schema.sql` is idempotent — every statement is `CREATE ... IF NOT EXISTS` — and contains **no seed data**.
- Every import of a local module uses an `.js` extension, even from `.ts` (ESM + `tsx`).
- **Never auto-publish.** Every kid article is inserted `status: 'pending_review'`, `publishedAt: null` (PRD §5.2 step 7, §2.2).
- LLM API keys live in environment variables only, never in the database (§13.2).
- `simplifyArticle` is the single entry point for raw → kid. Never reimplement simplification; the sandbox, Regenerate, scraping and this feature all go through it (§7.4).
- Default simplification budget is **10**, range **0–100**, stored in `app_settings.simplifyBudget`.
- Backlog ordering is **`ORDER BY publishedAt DESC`** — verified to put undated rows last in SQLite 3.49.2, which is wanted: an undated item is the lowest-priority candidate.
- Server tests: `cd server && npm test`. Typecheck: `npm run typecheck`. Web tests: `cd web && npm test`.
- Commit after every task. Do not squash tasks together.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `server/src/services/jobLock.ts` | One background job at a time; scrape and simplify are mutually exclusive |
| `server/src/services/simplifyBudget.ts` | Pure round-robin allocator — no database, no I/O |
| `server/src/services/simplifyService.ts` | The raw → kid engine plus the background job wrapper and its state |
| `server/src/routes/admin/rawArticles.ts` | Backlog listing, on-demand simplify, job status, and the moved sandbox dropdown endpoint |
| `server/tests/simplify-budget.test.ts` | The allocator's rules |
| `server/tests/simplify-service.test.ts` | The engine, the lock, resumability |
| `server/tests/admin-raw-articles.test.ts` | The new HTTP surface |
| `web/src/pages/admin/review/WaitingPanel.tsx` | The "Not yet simplified" tab: its own data, selection, polling |
| `web/src/__tests__/admin-waiting.test.tsx` | The tab's behaviour |

**Modified:**

| File | Change |
|---|---|
| `server/src/db/schema.sql` | Three new columns, one partial index |
| `server/src/db/init.ts` | `SCHEMA_VERSION` 3, `ALTER TABLE` migration, one-time backfill |
| `server/src/db/repositories/rawArticleRepository.ts` | `simplifiedAt` on the row; waiting queries; atomic `markSimplified` |
| `server/src/db/repositories/settingsRepository.ts` | `simplifyBudget` on `AppSettings` |
| `server/src/db/repositories/scrapeRunRepository.ts` | `simplified` and `leftWaiting` counts |
| `server/src/routes/admin/settings.ts` | Validate `simplifyBudget` |
| `server/src/routes/admin/articleQueue.ts` | `waiting` on the counts endpoint |
| `server/src/routes/admin/prompts.ts` | `GET /raw-articles` moves out |
| `server/src/app.ts` | Mount the new router |
| `server/src/ingestion/rssScraper.ts` | Phase 1 only; new `ScrapeResult` shape |
| `server/src/services/scrapeService.ts` | Two-phase run, budget, shared lock |
| `server/src/services/submitArticle.ts` | Stamp `simplifiedAt` |
| `server/src/db/seed-articles.ts` | Stamp `simplifiedAt` |
| `server/src/ingestion/scheduler.ts` | Log what the scheduled run spent |
| `server/scripts/scrape.ts` | Report the new counts |
| `web/src/admin/types.ts` | `waiting` count, `WaitingRawArticle`, `SimplifyJob` |
| `web/src/pages/admin/AdminReview.tsx` | Fourth tab, branch to `WaitingPanel` |
| `web/src/pages/admin/settings/types.ts` | `simplifyBudget`, new run counts |
| `web/src/pages/admin/settings/AppSettingsSection.tsx` | Budget input |
| `web/src/pages/admin/settings/ScrapeControls.tsx` | Show simplified / still-raw, simplifying phase |
| `README.md` | Flow diagram, budget section, tables, CLI output |

---

## Task 1: Schema, migration and backfill

**Files:**
- Modify: `server/src/db/schema.sql` (`raw_articles`, `app_settings`, `scrape_runs` blocks)
- Modify: `server/src/db/init.ts`
- Test: `server/tests/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `raw_articles.simplifiedAt TEXT NULL`, `app_settings.simplifyBudget INTEGER NOT NULL DEFAULT 10`, `scrape_runs.simplified INTEGER NOT NULL DEFAULT 0`, `scrape_runs.leftWaiting INTEGER NOT NULL DEFAULT 0`, `SCHEMA_VERSION === 3`, index `idx_raw_articles_waiting`.

**Why the ordering in this task is load-bearing:** `schema.sql` creates the partial index `WHERE simplifiedAt IS NULL`, which fails on an existing database that has no such column yet. So the `ALTER TABLE`s must run *before* `schema.sql` is executed. On a fresh database the tables don't exist yet, `PRAGMA table_info` returns an empty list, and the ALTER step skips itself.

The backfill is the dangerous part. `UPDATE raw_articles SET simplifiedAt = fetchedAt WHERE simplifiedAt IS NULL` is correct exactly once — when migrating from v2, where every stored raw really was simplified at fetch time. If it ran on every `npm run db:init` it would stamp genuinely-waiting articles as simplified and silently lose the backlog. It must be guarded on the version read *before* the upgrade.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/db.test.ts`, inside the `describe('schema (§8)')` block:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/db.test.ts`
Expected: FAIL — `user_version` is 2 not 3, and `no such column: simplifiedAt`.

- [ ] **Step 3: Add the columns and the index to `schema.sql`**

In the `raw_articles` block, after the `fetchedAt` line:

```sql
  fetchedAt   TEXT NOT NULL,                                    -- ISO
  -- ISO when a kid article was created from this raw; NULL while it waits.
  -- A scrape run stores every item but simplifies only app_settings.simplifyBudget
  -- of them (a deliberate divergence from §5.2, which runs steps 4-7 as one
  -- pass). NULL therefore means "stored, never sent to the model".
  -- Deliberately NOT derived from "has no kid_articles row": §4.2 Delete removes
  -- the kid row and leaves this one, and a deleted article must not reappear in
  -- the backlog asking to be paid for again.
  simplifiedAt TEXT
```

After the existing `raw_articles` indexes:

```sql
-- The backlog query only ever wants the NULLs, so the index only holds them.
CREATE INDEX IF NOT EXISTS idx_raw_articles_waiting
  ON raw_articles (sourceId, publishedAt DESC) WHERE simplifiedAt IS NULL;
```

In the `app_settings` block, after `llmProvider`:

```sql
  -- How many stored articles one scrape run may simplify (§5.2 divergence).
  -- 0 is legitimate: simplify nothing automatically. The ceiling is there so a
  -- typo in the settings form cannot cost a fortune.
  simplifyBudget INTEGER NOT NULL DEFAULT 10
                 CHECK (simplifyBudget BETWEEN 0 AND 100),
```

In the `scrape_runs` block, after `inserted`:

```sql
  simplified           INTEGER NOT NULL DEFAULT 0,              -- of the stored raws, how many were simplified
  leftWaiting          INTEGER NOT NULL DEFAULT 0,              -- this source's raws still waiting after the run
```

- [ ] **Step 4: Add the migration to `init.ts`**

Replace the `SCHEMA_VERSION` comment block and add the migration helpers:

```ts
/**
 * Bumped whenever schema.sql changes in a way an existing database must migrate
 * to. Every statement in schema.sql is CREATE ... IF NOT EXISTS, so re-running
 * `npm run db:init` adds new tables to an existing database without touching
 * the data already in it. Added COLUMNS need the ALTER pass below.
 *
 * 2 — added scrape_runs (§4.4 last-run results).
 * 3 — added raw_articles.simplifiedAt, app_settings.simplifyBudget and the
 *     scrape_runs simplification counts (the per-run simplification budget).
 */
export const SCHEMA_VERSION = 3;

/**
 * Columns added to tables that already existed in an earlier version.
 * ALTER TABLE ADD COLUMN is the only way to reach a database that already has
 * rows; schema.sql's CREATE ... IF NOT EXISTS cannot alter an existing table.
 *
 * Verified against the pinned better-sqlite3 (SQLite 3.49.2): ADD COLUMN
 * accepts NOT NULL with a non-NULL DEFAULT plus a CHECK, and backfills existing
 * rows with the default.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'raw_articles', column: 'simplifiedAt', definition: 'TEXT' },
  {
    table: 'app_settings',
    column: 'simplifyBudget',
    definition: 'INTEGER NOT NULL DEFAULT 10 CHECK (simplifyBudget BETWEEN 0 AND 100)',
  },
  { table: 'scrape_runs', column: 'simplified', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'scrape_runs', column: 'leftWaiting', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

/**
 * Runs BEFORE schema.sql, because schema.sql creates an index over
 * simplifiedAt and that fails on a database where the column is still missing.
 * A table that does not exist yet reports no columns, so a fresh database
 * skips every entry and gets the columns from CREATE TABLE instead.
 */
function addMissingColumns(db: Database): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    if (columns.length === 0) continue;
    if (columns.some((existing) => existing.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
```

Add the `Database` type import at the top:

```ts
import type { Database } from 'better-sqlite3';
```

Then rewrite the body of `initialiseSchema`'s `try` block:

```ts
    const previousVersion = db.pragma('user_version', { simple: true }) as number;
    if (previousVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database at ${path} is schema version ${previousVersion}, but this code understands ` +
          `version ${SCHEMA_VERSION}. Refusing to run against a newer database.`,
      );
    }

    addMissingColumns(db);
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

    // Before v3 every stored raw was simplified at the moment it was stored, so
    // a NULL here means "migrated", not "waiting". Guarded on the version read
    // above: running this on a v3 database would stamp the real backlog as
    // simplified and lose it.
    if (previousVersion > 0 && previousVersion < 3) {
      db.exec(`UPDATE raw_articles SET simplifiedAt = fetchedAt WHERE simplifiedAt IS NULL`);
    }

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/db.test.ts && npm run typecheck`
Expected: PASS, including the pre-existing `creates every table` and `SCHEMA_VERSION` tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.sql server/src/db/init.ts server/tests/db.test.ts
git commit -m "feat(db): add simplifiedAt, simplifyBudget and per-run simplification counts"
```

---

## Task 2: Raw-article repository — the waiting backlog

**Files:**
- Modify: `server/src/db/repositories/rawArticleRepository.ts`
- Modify: `server/src/services/submitArticle.ts:151` (stamp `simplifiedAt`)
- Modify: `server/src/db/seed-articles.ts:333` (stamp `simplifiedAt`)
- Modify: `server/src/ingestion/rssScraper.ts:120` (pass `simplifiedAt: null` — a compile fix only; the real rewrite is Task 7)
- Test: `server/tests/db.test.ts`

**Interfaces:**
- Consumes: Task 1's `raw_articles.simplifiedAt`.
- Produces:
  ```ts
  interface RawArticle { /* ...existing fields... */ simplifiedAt: string | null }
  interface WaitingRawArticle {
    id: string; sourceId: string; sourceName: string; headline: string;
    url: string; topic: string; publishedAt: string | null; fetchedAt: string;
    bodyLength: number;
  }
  listWaiting(options?: { sourceId?: string; limit?: number }): WaitingRawArticle[]
  countWaiting(): number
  countWaitingForSource(sourceId: string): number
  waitingIdsBySource(): { sourceId: string; rawIds: string[] }[]
  markSimplified(id: string, at: string): boolean   // false when already claimed
  ```

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of `server/tests/db.test.ts`:

```ts
describe('the waiting backlog (raw_articles.simplifiedAt)', () => {
  let db: ReturnType<typeof openDatabase>;

  const raw = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
    id, sourceId: 'bbc', sourceName: 'BBC News', sourceUrl: 'https://feed',
    url: `https://example.com/${id}`, headline: `Headline ${id}`, body: 'Body text here',
    topic: 'World', publishedAt: null, fetchedAt: '2026-09-08T00:00:00.000Z',
    simplifiedAt: null, ...over,
  });

  beforeEach(() => {
    initialiseSchema(path);
    seed(path);
    db = openDatabase(path);
  });
  afterEach(() => db.close());

  it('lists only unsimplified rows, newest published first, undated last', () => {
    const repo = createRawArticleRepository(db);
    repo.insert(raw('older', { publishedAt: '2026-09-01T00:00:00.000Z' }));
    repo.insert(raw('newer', { publishedAt: '2026-09-07T00:00:00.000Z' }));
    repo.insert(raw('undated'));
    repo.insert(raw('done', {
      publishedAt: '2026-09-09T00:00:00.000Z', simplifiedAt: '2026-09-09T01:00:00.000Z',
    }));

    expect(repo.listWaiting().map((a) => a.id)).toEqual(['newer', 'older', 'undated']);
    expect(repo.countWaiting()).toBe(3);
  });

  it('reports the body length so the editor can judge a stub before spending a call', () => {
    createRawArticleRepository(db).insert(raw('r1', { body: 'twelve chars' }));
    expect(createRawArticleRepository(db).listWaiting()[0].bodyLength).toBe(12);
  });

  it('filters by source and honours a limit', () => {
    const repo = createRawArticleRepository(db);
    repo.insert(raw('b1'));
    repo.insert(raw('b2'));
    repo.insert(raw('m1', { sourceId: 'manual', sourceName: 'Manual submission' }));

    expect(repo.listWaiting({ sourceId: 'manual' }).map((a) => a.id)).toEqual(['m1']);
    expect(repo.listWaiting({ limit: 1 })).toHaveLength(1);
    expect(repo.countWaitingForSource('bbc')).toBe(2);
  });

  it('groups waiting ids by source, newest first — the round-robin input', () => {
    const repo = createRawArticleRepository(db);
    repo.insert(raw('b-old', { publishedAt: '2026-09-01T00:00:00.000Z' }));
    repo.insert(raw('b-new', { publishedAt: '2026-09-05T00:00:00.000Z' }));
    repo.insert(raw('m-one', {
      sourceId: 'manual', sourceName: 'Manual submission', publishedAt: '2026-09-03T00:00:00.000Z',
    }));

    expect(repo.waitingIdsBySource()).toEqual([
      { sourceId: 'bbc', rawIds: ['b-new', 'b-old'] },
      { sourceId: 'manual', rawIds: ['m-one'] },
    ]);
  });

  it('markSimplified claims a row exactly once', () => {
    const repo = createRawArticleRepository(db);
    repo.insert(raw('r1'));

    expect(repo.markSimplified('r1', '2026-09-09T10:00:00.000Z')).toBe(true);
    // A second claim — two browser tabs submitting the same id — must lose,
    // which is what stops a second kid article being written for one raw.
    expect(repo.markSimplified('r1', '2026-09-09T10:00:05.000Z')).toBe(false);
    expect(repo.findById('r1')?.simplifiedAt).toBe('2026-09-09T10:00:00.000Z');
    expect(repo.countWaiting()).toBe(0);
  });

  it('a manual submission is never in the backlog', async () => {
    // §4.3 submissions arrive already simplified, so they must not show up as
    // waiting for a simplification they have already had.
    await createManualArticle(
      db,
      {
        headline: 'Editor wrote this', body: 'A long enough body for the pipeline to chew on.',
        category: 'World', sourceName: 'Editor', sourceUrl: 'https://example.com/manual',
        ageTarget: 8,
      },
      {},
      'pending_review',
    );
    expect(createRawArticleRepository(db).countWaiting()).toBe(0);
  });
});
```

Add these two imports to `server/tests/db.test.ts` (`afterEach`, `beforeEach`, `describe`, `expect` and `it` are already imported at the top of the file — reuse those):

```ts
import { createRawArticleRepository } from '../src/db/repositories/rawArticleRepository.js';
import { createManualArticle } from '../src/services/submitArticle.js';
```

The real export is `createManualArticle(db, submission, overrides, status)` — there is no `submitArticle` function despite the filename. `Submission` is `{ headline, sourceName, sourceUrl, body, category, ageTarget }`, all six required.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/db.test.ts`
Expected: FAIL — `repo.listWaiting is not a function`.

- [ ] **Step 3: Implement the repository**

Rewrite `server/src/db/repositories/rawArticleRepository.ts`:

```ts
/** All SQL touching raw_articles (PRD §8.2). */
import type { Database } from 'better-sqlite3';

export interface RawArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  url: string;
  headline: string;
  body: string;
  topic: string;
  publishedAt: string | null;
  fetchedAt: string;
  /**
   * ISO when a kid article was created from this raw; NULL while it waits.
   * A scrape stores every item but simplifies only app_settings.simplifyBudget
   * of them, so NULL is the backlog this feature exists to manage.
   */
  simplifiedAt: string | null;
}

const COLUMNS = [
  'id', 'sourceId', 'sourceName', 'sourceUrl', 'url',
  'headline', 'body', 'topic', 'publishedAt', 'fetchedAt', 'simplifiedAt',
] as const;

/** One backlog row as the review queue's "Not yet simplified" tab shows it. */
export interface WaitingRawArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  headline: string;
  url: string;
  topic: string;
  publishedAt: string | null;
  fetchedAt: string;
  /** So an editor can spot a one-line stub before spending a call on it. */
  bodyLength: number;
}

export interface RawArticleRepository {
  insert(article: RawArticle): void;
  findById(id: string): RawArticle | undefined;
  /** §5.2: an item already stored for this source must not be stored twice. */
  existsForSourceUrl(sourceId: string, url: string): boolean;
  countForSource(sourceId: string): number;
  /** Unsimplified rows only. Newest publishedAt first; undated last. */
  listWaiting(options?: { sourceId?: string; limit?: number }): WaitingRawArticle[];
  countWaiting(): number;
  countWaitingForSource(sourceId: string): number;
  /** Waiting ids grouped by source, each newest-first: the round-robin input. */
  waitingIdsBySource(): { sourceId: string; rawIds: string[] }[];
  /**
   * Claims a row for simplification. Returns false when it was already claimed,
   * which is how two concurrent submits of the same id cannot both write a kid
   * article for it.
   */
  markSimplified(id: string, at: string): boolean;
}

export function createRawArticleRepository(db: Database): RawArticleRepository {
  const insert = db.prepare(
    `INSERT INTO raw_articles (${COLUMNS.join(', ')})
     VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`,
  );
  const byId = db.prepare(`SELECT * FROM raw_articles WHERE id = ?`);
  const bySourceUrl = db.prepare(`SELECT 1 FROM raw_articles WHERE sourceId = ? AND url = ? LIMIT 1`);
  const countBySource = db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE sourceId = ?`);

  // ORDER BY publishedAt DESC puts NULLs last in SQLite, which is wanted: an
  // undated item is the lowest-priority candidate for a scarce budget.
  const waiting = db.prepare(
    `SELECT r.id, r.sourceId, r.sourceName, r.headline, r.url, r.topic,
            r.publishedAt, r.fetchedAt, LENGTH(r.body) AS bodyLength
     FROM raw_articles r
     WHERE r.simplifiedAt IS NULL
       AND (@sourceId IS NULL OR r.sourceId = @sourceId)
     ORDER BY r.publishedAt DESC, r.fetchedAt DESC, r.id
     LIMIT @limit`,
  );
  const countAllWaiting = db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL`);
  const countSourceWaiting = db.prepare(
    `SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL AND sourceId = ?`,
  );
  const waitingIds = db.prepare(
    `SELECT id, sourceId FROM raw_articles WHERE simplifiedAt IS NULL
     ORDER BY sourceId, publishedAt DESC, fetchedAt DESC, id`,
  );
  // The WHERE clause is the claim: only an unclaimed row is updated.
  const claim = db.prepare(
    `UPDATE raw_articles SET simplifiedAt = @at WHERE id = @id AND simplifiedAt IS NULL`,
  );

  return {
    insert: (article) => void insert.run(article),
    findById: (id) => byId.get(id) as RawArticle | undefined,
    existsForSourceUrl: (sourceId, url) => bySourceUrl.get(sourceId, url) !== undefined,
    countForSource: (sourceId) => countBySource.pluck().get(sourceId) as number,

    listWaiting: ({ sourceId, limit } = {}) =>
      waiting.all({ sourceId: sourceId ?? null, limit: limit ?? 50 }) as WaitingRawArticle[],

    countWaiting: () => countAllWaiting.pluck().get() as number,
    countWaitingForSource: (sourceId) => countSourceWaiting.pluck().get(sourceId) as number,

    waitingIdsBySource() {
      const groups: { sourceId: string; rawIds: string[] }[] = [];
      for (const row of waitingIds.all() as { id: string; sourceId: string }[]) {
        const last = groups[groups.length - 1];
        if (last?.sourceId === row.sourceId) last.rawIds.push(row.id);
        else groups.push({ sourceId: row.sourceId, rawIds: [row.id] });
      }
      return groups;
    },

    markSimplified: (id, at) => claim.run({ id, at }).changes === 1,
  };
}
```

- [ ] **Step 4: Fix the three insert call sites**

`server/src/services/submitArticle.ts`, inside the `createRawArticleRepository(db).insert({...})` call, after `fetchedAt: now,`:

```ts
      // §4.3 submissions arrive already simplified, in the same transaction, so
      // they must never appear in the "not yet simplified" backlog.
      simplifiedAt: now,
```

`server/src/db/seed-articles.ts` — the `insertRaw` statement, so sample data is never in the backlog:

```ts
    const insertRaw = db.prepare(
      `INSERT INTO raw_articles
         (id, sourceId, sourceName, sourceUrl, url, headline, body, topic, publishedAt,
          fetchedAt, simplifiedAt)
       VALUES (@id, @sourceId, @sourceName, @sourceUrl, @url, @headline, @body, @topic,
               @publishedAt, @fetchedAt, @simplifiedAt)`,
    );
```

and its binding, where `createdAt` is already in scope — every sample ships with a kid article, so it is simplified by definition:

```ts
      insertRaw.run({
        id: rawId,
        ...sample.original,
        topic: sample.kid.category,
        publishedAt: createdAt,
        fetchedAt: createdAt,
        simplifiedAt: createdAt,
      });
```

`server/src/ingestion/rssScraper.ts`, in the existing `rawArticles.insert({...})` call, after `fetchedAt,`:

```ts
        simplifiedAt: null,
```

This is only enough to keep the file compiling; the real phase-1 rewrite is Task 7.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. The whole suite, not just `db.test.ts` — this task changed a shared repository interface.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/repositories/rawArticleRepository.ts server/src/services/submitArticle.ts \
        server/src/db/seed-articles.ts server/src/ingestion/rssScraper.ts server/tests/db.test.ts
git commit -m "feat(db): query and claim the unsimplified raw-article backlog"
```

---

## Task 3: The `simplifyBudget` setting

**Files:**
- Modify: `server/src/db/repositories/settingsRepository.ts:26-31,121-140`
- Modify: `server/src/routes/admin/settings.ts:109-129`
- Test: `server/tests/admin-settings.test.ts`

**Interfaces:**
- Consumes: Task 1's `app_settings.simplifyBudget`.
- Produces: `AppSettings.simplifyBudget: number`; `PUT /api/admin/app-settings` accepts and validates it.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/admin-settings.test.ts` (put it in the app-settings `describe` if one exists, otherwise append a new one):

```ts
describe('the simplification budget (§8.7)', () => {
  it('defaults to 10 and round-trips a new value', async () => {
    const before = await (await ctx.api('/api/admin/app-settings')).json();
    expect(before.simplifyBudget).toBe(10);

    const res = await ctx.api('/api/admin/app-settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultAge: 6, scrapeTimes: ['06:00'], llmProvider: null, simplifyBudget: 4 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).simplifyBudget).toBe(4);
    expect((await (await ctx.api('/api/admin/app-settings')).json()).simplifyBudget).toBe(4);
  });

  it('accepts 0 — simplify nothing automatically', async () => {
    const res = await ctx.api('/api/admin/app-settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultAge: 6, scrapeTimes: [], llmProvider: null, simplifyBudget: 0 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).simplifyBudget).toBe(0);
  });

  it.each([[-1], [101], ['ten'], [2.5]])('rejects %p', async (value) => {
    const res = await ctx.api('/api/admin/app-settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultAge: 6, scrapeTimes: [], llmProvider: null, simplifyBudget: value }),
    });
    expect(res.status).toBe(400);
  });

  it('leaves the budget alone when the field is absent', async () => {
    // An older client PUTting the pre-budget body must not silently reset it.
    await ctx.api('/api/admin/app-settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultAge: 6, scrapeTimes: [], llmProvider: null, simplifyBudget: 3 }),
    });
    await ctx.api('/api/admin/app-settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultAge: 7, scrapeTimes: [], llmProvider: null }),
    });
    expect((await (await ctx.api('/api/admin/app-settings')).json()).simplifyBudget).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/admin-settings.test.ts`
Expected: FAIL — `expected undefined to be 10`.

- [ ] **Step 3: Thread it through the repository**

In `server/src/db/repositories/settingsRepository.ts`, extend the interface:

```ts
export interface AppSettings {
  defaultAge: number;
  scrapeTimes: string[];
  llmProvider: string | null;
  /** How many stored articles one scrape run may simplify. 0 disables it. */
  simplifyBudget: number;
}
```

In `getAppSettings`, add to the returned object:

```ts
        simplifyBudget: Number(row.simplifyBudget),
```

In `saveAppSettings`, extend the UPDATE and its bindings:

```ts
    saveAppSettings(settings) {
      db.prepare(
        `UPDATE app_settings SET defaultAge = @defaultAge, scrapeTimes = @scrapeTimes,
           llmProvider = @llmProvider, simplifyBudget = @simplifyBudget
         WHERE id = 'default'`,
      ).run({
        defaultAge: settings.defaultAge,
        scrapeTimes: JSON.stringify(settings.scrapeTimes),
        llmProvider: settings.llmProvider,
        simplifyBudget: settings.simplifyBudget,
      });
    },
```

- [ ] **Step 4: Validate it in the route**

In `server/src/routes/admin/settings.ts`, add `requireInt` to the existing validation import, then replace the `saved` object in `PUT /app-settings`:

```ts
    const current = settings.getAppSettings();

    const saved = {
      defaultAge: requireAgeTarget(body.defaultAge, 'defaultAge'),
      scrapeTimes: times,
      llmProvider: optionalString(body.llmProvider),
      // Absent means "leave it alone", so a client that predates this field
      // cannot silently reset the budget to a default.
      simplifyBudget:
        body.simplifyBudget === undefined
          ? current.simplifyBudget
          : requireInt(body.simplifyBudget, 'simplifyBudget', { min: 0, max: 100 }),
    };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/repositories/settingsRepository.ts server/src/routes/admin/settings.ts \
        server/tests/admin-settings.test.ts
git commit -m "feat(settings): make the per-run simplification budget configurable"
```

---

## Task 4: The round-robin allocator

**Files:**
- Create: `server/src/services/simplifyBudget.ts`
- Test: `server/tests/simplify-budget.test.ts`

**Interfaces:**
- Consumes: nothing — deliberately pure, no database and no I/O.
- Produces:
  ```ts
  interface SourceQueue { sourceId: string; rawIds: string[] }
  function selectBudgetedBatch(queues: SourceQueue[], budget: number): string[]
  ```

- [ ] **Step 1: Write the failing test**

Create `server/tests/simplify-budget.test.ts`:

```ts
/**
 * How a scrape run decides which articles get the LLM budget.
 *
 * Pure function, so these are plain unit tests: no database, no feed, no model.
 */
import { describe, expect, it } from 'vitest';
import { selectBudgetedBatch, type SourceQueue } from '../src/services/simplifyBudget.js';

/** n waiting ids for one source, newest first, named so order is visible. */
const queue = (sourceId: string, n: number): SourceQueue => ({
  sourceId,
  rawIds: Array.from({ length: n }, (_, i) => `${sourceId}-${i + 1}`),
});

const countsBySource = (picked: string[]) => {
  const counts: Record<string, number> = {};
  for (const id of picked) {
    const source = id.slice(0, id.lastIndexOf('-'));
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
};

describe('selectBudgetedBatch', () => {
  it('spreads the budget across sources instead of letting one feed take it all', () => {
    const picked = selectBudgetedBatch(
      [queue('bbc', 20), queue('reuters', 20), queue('ap', 20), queue('npr', 20)],
      10,
    );

    expect(picked).toHaveLength(10);
    expect(countsBySource(picked)).toEqual({ bbc: 3, reuters: 3, ap: 2, npr: 2 });
  });

  it('takes the newest first within each source', () => {
    // Each queue arrives newest-first, so the first pick from each is its newest.
    const picked = selectBudgetedBatch([queue('bbc', 3), queue('npr', 3)], 4);
    expect(picked).toEqual(['bbc-1', 'npr-1', 'bbc-2', 'npr-2']);
  });

  it('lets a thin source hand its unused share to the others', () => {
    // The whole point of round-robin over pre-allocation: a source with one
    // candidate takes one, and the budget is still fully spent.
    const picked = selectBudgetedBatch([queue('bbc', 1), queue('npr', 20)], 10);

    expect(picked).toHaveLength(10);
    expect(countsBySource(picked)).toEqual({ bbc: 1, npr: 9 });
  });

  it('spends nothing when the budget is 0', () => {
    expect(selectBudgetedBatch([queue('bbc', 20)], 0)).toEqual([]);
  });

  it('treats a negative budget as 0 rather than looping', () => {
    expect(selectBudgetedBatch([queue('bbc', 20)], -5)).toEqual([]);
  });

  it('takes everything when the budget exceeds the backlog', () => {
    const picked = selectBudgetedBatch([queue('bbc', 2), queue('npr', 1)], 10);
    expect(picked.sort()).toEqual(['bbc-1', 'bbc-2', 'npr-1']);
  });

  it('is a plain take-the-first-N for a single source', () => {
    expect(selectBudgetedBatch([queue('bbc', 5)], 3)).toEqual(['bbc-1', 'bbc-2', 'bbc-3']);
  });

  it('returns nothing when there is nothing waiting', () => {
    expect(selectBudgetedBatch([], 10)).toEqual([]);
    expect(selectBudgetedBatch([queue('bbc', 0)], 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/simplify-budget.test.ts`
Expected: FAIL — cannot resolve `../src/services/simplifyBudget.js`.

- [ ] **Step 3: Implement the allocator**

Create `server/src/services/simplifyBudget.ts`:

```ts
/**
 * Choosing which raw articles a scrape run spends its LLM budget on.
 *
 * PRD §5.2 runs steps 4-7 over every item, which is 40-50 model calls across
 * four feeds for a queue an editor will triage ten of. This caps the spend.
 *
 * Round-robin rather than "the first N overall", so one busy feed cannot use
 * the whole budget and leave the others unrepresented in the queue. A source
 * with fewer candidates than its notional share simply runs dry and the
 * remainder flows to the others — which is why this beats pre-allocating
 * budget/n per source, where a thin feed wastes its share.
 *
 * Pure by design: no database, no clock, no model. The allocation rule is the
 * part worth testing exhaustively, and this keeps it cheap to do so.
 */

export interface SourceQueue {
  sourceId: string;
  /** Waiting raw article ids, newest first. */
  rawIds: string[];
}

export function selectBudgetedBatch(queues: SourceQueue[], budget: number): string[] {
  if (budget <= 0) return [];

  const picked: string[] = [];
  const taken = queues.map(() => 0);

  // Keep going round while at least one queue still had something to give.
  let progressed = true;
  while (picked.length < budget && progressed) {
    progressed = false;

    for (let i = 0; i < queues.length && picked.length < budget; i += 1) {
      const { rawIds } = queues[i];
      if (taken[i] >= rawIds.length) continue;

      picked.push(rawIds[taken[i]]);
      taken[i] += 1;
      progressed = true;
    }
  }

  return picked;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/simplify-budget.test.ts && npm run typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/simplifyBudget.ts server/tests/simplify-budget.test.ts
git commit -m "feat(scrape): add the round-robin simplification budget allocator"
```

---

## Task 5: The shared job lock

**Files:**
- Create: `server/src/services/jobLock.ts`
- Test: `server/tests/simplify-service.test.ts` (created here, extended in Task 6)

**Interfaces:**
- Consumes: `ConflictError` from `server/src/core/errors.js`.
- Produces:
  ```ts
  type JobKind = 'scrape' | 'simplify'
  function acquireJob(kind: JobKind): void   // throws ConflictError when held
  function releaseJob(): void
  function activeJob(): JobKind | null
  ```

**Constraint:** `server/tests/scrape-run.test.ts:104,215` assert the conflict message matches `/already running/`. Both messages below contain "is already running", so those tests must keep passing untouched.

- [ ] **Step 1: Write the failing test**

Create `server/tests/simplify-service.test.ts`:

```ts
/**
 * On-demand simplification and the one-job-at-a-time rule.
 *
 * The lock is not tidiness: a scrape's simplification phase and a manual batch
 * both write kid_articles for raw rows, so running them together could write
 * two kid articles for one raw article.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { acquireJob, activeJob, releaseJob } from '../src/services/jobLock.js';

describe('jobLock', () => {
  beforeEach(() => releaseJob());

  it('is free to begin with', () => {
    expect(activeJob()).toBeNull();
  });

  it('refuses a second job while one is held, naming the holder', () => {
    acquireJob('scrape');
    expect(activeJob()).toBe('scrape');
    expect(() => acquireJob('simplify')).toThrow(/scrape is already running/);
  });

  it('refuses a scrape while a simplification batch is running', () => {
    acquireJob('simplify');
    expect(() => acquireJob('scrape')).toThrow(/simplification batch is already running/);
  });

  it('can be taken again after release', () => {
    acquireJob('simplify');
    releaseJob();
    expect(activeJob()).toBeNull();
    expect(() => acquireJob('scrape')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/simplify-service.test.ts`
Expected: FAIL — cannot resolve `../src/services/jobLock.js`.

- [ ] **Step 3: Implement the lock**

Create `server/src/services/jobLock.ts`:

```ts
/**
 * One background job at a time, across every kind of job.
 *
 * A scrape run's simplification phase and a manual simplify batch both turn raw
 * articles into kid articles, so allowing them to overlap risks two kid
 * articles for one raw. They are therefore mutually exclusive, not merely
 * "one scrape at a time" as the scrape service used to enforce on its own.
 *
 * Module-level, because the whole app is one process with one admin (§2.2). If
 * this ever runs as more than one instance, the lock has to move into the
 * database.
 */
import { ConflictError } from '../core/errors.js';

export type JobKind = 'scrape' | 'simplify';

const HOLDER: Record<JobKind, string> = {
  scrape: 'A scrape is already running',
  simplify: 'A simplification batch is already running',
};

const WANTED: Record<JobKind, string> = {
  scrape: 'starting another scrape',
  simplify: 'simplifying more articles',
};

let held: JobKind | null = null;

export function activeJob(): JobKind | null {
  return held;
}

/** Throws ConflictError (HTTP 409) naming whichever job holds the lock. */
export function acquireJob(kind: JobKind): void {
  if (held) {
    throw new ConflictError(`${HOLDER[held]}. Wait for it to finish before ${WANTED[kind]}.`);
  }
  held = kind;
}

/** Always call this from a `finally`, so a thrown job cannot leak the lock. */
export function releaseJob(): void {
  held = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/simplify-service.test.ts && npm run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/jobLock.ts server/tests/simplify-service.test.ts
git commit -m "feat(scrape): add a shared lock so scraping and simplifying cannot overlap"
```

---

## Task 6: The simplification engine and its background job

**Files:**
- Create: `server/src/services/simplifyService.ts`
- Test: `server/tests/simplify-service.test.ts` (extend Task 5's file)

**Interfaces:**
- Consumes: `createRawArticleRepository` (Task 2, for `findById`/`markSimplified`/`countWaiting`), `AppSettings.simplifyBudget` and `defaultAge` (Task 3), `acquireJob`/`releaseJob` (Task 5), `simplifyArticle` from `../pipeline/simplifyArticle.js`, `createArticleRepository`.
- Produces:
  ```ts
  interface SimplifiedRow {
    rawId: string; sourceId: string; kidHeadline: string; safety: string;
    engine: string; costUsd: number; fallbackReason?: string;
  }
  interface SimplifyFailure { rawId: string; error: string }
  interface SimplifyReport {
    simplified: SimplifiedRow[]; failures: SimplifyFailure[]; skipped: string[];
  }
  interface SimplifyOptions {
    client?: OpenRouterClient; now?: () => string; onProgress?: (done: number) => void;
  }
  interface SimplifyJobState {
    id: string; startedAt: string; finishedAt?: string; rawIds: string[];
    done: number; running: boolean; report: SimplifyReport;
  }
  async function simplifyRawArticles(db, rawIds: string[], options?: SimplifyOptions): Promise<SimplifyReport>
  function startSimplifyJob(db, rawIds: string[], options?: SimplifyOptions & { onFinished?: (s: SimplifyJobState) => void }): SimplifyJobState
  function getSimplifyJob(): SimplifyJobState | null
  function resetSimplifyJob(): void   // test seam; also releases the lock
  ```

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/simplify-service.test.ts`:

```ts
import { afterEach } from 'vitest';
import { createRawArticleRepository } from '../src/db/repositories/rawArticleRepository.js';
import {
  getSimplifyJob, resetSimplifyJob, simplifyRawArticles, startSimplifyJob,
  type SimplifyJobState,
} from '../src/services/simplifyService.js';
import { countRows, createTestContext, type TestContext } from './helpers.js';

describe('simplifyRawArticles', () => {
  let ctx: TestContext;

  /** A waiting raw article, i.e. one a scrape stored but did not simplify. */
  const seedWaiting = (id: string, over: Record<string, unknown> = {}) => {
    createRawArticleRepository(ctx.db).insert({
      id, sourceId: 'bbc', sourceName: 'BBC News', sourceUrl: 'https://feed',
      url: `https://example.com/${id}`, headline: `Adult headline ${id}`,
      body: 'A rover surveyed the reef and found the coral healthy this year.',
      topic: 'World', publishedAt: '2026-09-08T00:00:00.000Z',
      fetchedAt: '2026-09-08T01:00:00.000Z', simplifiedAt: null, ...over,
    });
  };

  beforeEach(() => { ctx = createTestContext(); resetSimplifyJob(); });
  afterEach(() => { ctx.close(); resetSimplifyJob(); });

  it('creates a pending_review kid article and stamps the raw as simplified', async () => {
    seedWaiting('r1');

    const report = await simplifyRawArticles(ctx.db, ['r1'], { now: () => '2026-09-09T10:00:00.000Z' });

    expect(report.simplified).toHaveLength(1);
    expect(report.failures).toEqual([]);
    expect(countRows(ctx.db, 'kid_articles')).toBe(1);

    const article = ctx.db.prepare(`SELECT status, publishedAt, originalId FROM kid_articles`).get() as
      { status: string; publishedAt: string | null; originalId: string };
    // §5.2 step 7 / §2.2: nothing this feature touches may auto-publish.
    expect(article.status).toBe('pending_review');
    expect(article.publishedAt).toBeNull();
    expect(article.originalId).toBe('r1');

    expect(createRawArticleRepository(ctx.db).findById('r1')?.simplifiedAt)
      .toBe('2026-09-09T10:00:00.000Z');
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(0);
  });

  it('leaves the backlog alone for ids it was not given', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    await simplifyRawArticles(ctx.db, ['r1']);

    expect(countRows(ctx.db, 'kid_articles')).toBe(1);
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);
  });

  it('skips an already-simplified id instead of writing a second kid article', async () => {
    seedWaiting('r1');
    await simplifyRawArticles(ctx.db, ['r1']);

    const again = await simplifyRawArticles(ctx.db, ['r1']);

    expect(again.skipped).toEqual(['r1']);
    expect(again.simplified).toEqual([]);
    expect(countRows(ctx.db, 'kid_articles')).toBe(1);
  });

  it('reports an unknown id as a failure without stopping the batch', async () => {
    seedWaiting('r1');

    const report = await simplifyRawArticles(ctx.db, ['nope', 'r1']);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].rawId).toBe('nope');
    // The good one still went through: the batch is resumable, not all-or-nothing.
    expect(report.simplified.map((row) => row.rawId)).toEqual(['r1']);
  });

  it('reports progress as it goes, so a poller can show a count', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    const seen: number[] = [];
    await simplifyRawArticles(ctx.db, ['r1', 'r2'], { onProgress: (done) => seen.push(done) });

    expect(seen).toEqual([1, 2]);
  });
});

describe('startSimplifyJob', () => {
  let ctx: TestContext;

  const seedWaiting = (id: string) => {
    createRawArticleRepository(ctx.db).insert({
      id, sourceId: 'bbc', sourceName: 'BBC News', sourceUrl: 'https://feed',
      url: `https://example.com/${id}`, headline: `Adult headline ${id}`,
      body: 'A rover surveyed the reef and found the coral healthy this year.',
      topic: 'World', publishedAt: '2026-09-08T00:00:00.000Z',
      fetchedAt: '2026-09-08T01:00:00.000Z', simplifiedAt: null,
    });
  };

  beforeEach(() => { ctx = createTestContext(); resetSimplifyJob(); });
  afterEach(() => { ctx.close(); resetSimplifyJob(); });

  it('returns immediately and finishes in the background', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    const done = new Promise<SimplifyJobState>((resolve) => {
      const state = startSimplifyJob(ctx.db, ['r1', 'r2'], { onFinished: resolve });
      expect(state.running).toBe(true);
      expect(state.rawIds).toEqual(['r1', 'r2']);
      expect(getSimplifyJob()?.id).toBe(state.id);
    });

    const state = await done;
    expect(state.running).toBe(false);
    expect(state.finishedAt).toBeTruthy();
    expect(state.done).toBe(2);
    expect(state.report.simplified).toHaveLength(2);
    expect(countRows(ctx.db, 'kid_articles')).toBe(2);
  });

  it('holds the lock while running and releases it at the end', async () => {
    seedWaiting('r1');

    const done = new Promise<SimplifyJobState>((resolve) => {
      startSimplifyJob(ctx.db, ['r1'], { onFinished: resolve });
      expect(activeJob()).toBe('simplify');
      expect(() => startSimplifyJob(ctx.db, ['r1'])).toThrow(/already running/);
    });

    await done;
    expect(activeJob()).toBeNull();
  });

  it('rejects an empty selection', () => {
    expect(() => startSimplifyJob(ctx.db, [])).toThrow(/no articles/i);
    // A rejected start must not leave the lock held.
    expect(activeJob()).toBeNull();
  });
});
```

These tests need `activeJob` too, so extend Task 5's import line to `import { acquireJob, activeJob, releaseJob } from '../src/services/jobLock.js';` if it is not already.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/simplify-service.test.ts`
Expected: FAIL — cannot resolve `../src/services/simplifyService.js`.

- [ ] **Step 3: Implement the service**

Create `server/src/services/simplifyService.ts`:

```ts
/**
 * Turning waiting raw articles into kid articles, on purpose rather than by
 * default.
 *
 * PRD §5.2 lists steps 4-7 as one pass, simplifying every item a feed offers.
 * That is 40-50 model calls per run for a queue an editor triages ten of, so
 * ingestion stops at step 5 and this module owns steps 6-7 under a budget
 * (scrape phase 2) or an editor's explicit request (the review queue's
 * "Not yet simplified" tab). Both go through the same function, so the
 * automatic and manual paths cannot drift apart.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../core/errors.js';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { createSettingsRepository } from '../db/repositories/settingsRepository.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import { simplifyArticle } from '../pipeline/simplifyArticle.js';
import { acquireJob, releaseJob } from './jobLock.js';

export interface SimplifiedRow {
  rawId: string;
  /** Carried so a scrape run can attribute the cost back to the right source. */
  sourceId: string;
  kidHeadline: string;
  safety: string;
  engine: string;
  costUsd: number;
  fallbackReason?: string;
}

export interface SimplifyFailure {
  rawId: string;
  error: string;
}

export interface SimplifyReport {
  simplified: SimplifiedRow[];
  failures: SimplifyFailure[];
  /** Ids that were already simplified — a double submit, not an error. */
  skipped: string[];
}

export interface SimplifyOptions {
  /** Test and sandbox seam; without one, simplifyArticle reads LLM_ENABLED. */
  client?: OpenRouterClient;
  now?: () => string;
  /** Called with the number of ids attempted so far, for progress polling. */
  onProgress?: (done: number) => void;
}

/**
 * Simplify exactly these raw articles, one at a time.
 *
 * Each article is its own transaction. simplifyArticle is async and so cannot
 * sit inside a better-sqlite3 transaction anyway, and committing per article
 * makes a batch resumable: a failure on the seventh keeps the first six and
 * leaves the rest waiting for another attempt.
 *
 * Does NOT take the job lock — callers own that, because a scrape run holds it
 * across both of its phases.
 */
export async function simplifyRawArticles(
  db: Database,
  rawIds: string[],
  options: SimplifyOptions = {},
): Promise<SimplifyReport> {
  const raws = createRawArticleRepository(db);
  const articles = createArticleRepository(db);
  const { defaultAge } = createSettingsRepository(db).getAppSettings();
  const clock = options.now ?? (() => new Date().toISOString());

  const report: SimplifyReport = { simplified: [], failures: [], skipped: [] };
  let done = 0;

  for (const rawId of rawIds) {
    try {
      const raw = raws.findById(rawId);
      if (!raw) {
        report.failures.push({ rawId, error: `Raw article '${rawId}' no longer exists.` });
        continue;
      }
      if (raw.simplifiedAt !== null) {
        report.skipped.push(rawId);
        continue;
      }

      const now = clock();
      // simplifyArticle never throws: it falls back to the rule-based pipeline
      // (§9.2) and flags why, so there is no "unsimplifiable" article here.
      const outcome = await simplifyArticle(
        db,
        {
          id: raw.id,
          headline: raw.headline,
          body: raw.body,
          topic: raw.topic,
          sourceName: raw.sourceName,
          sourceUrl: raw.sourceUrl,
        },
        { ageTarget: defaultAge, now, client: options.client },
      );

      const claimed = db.transaction(() => {
        // The claim and the insert commit together: if another writer got here
        // first, markSimplified reports false and no second kid article exists.
        if (!raws.markSimplified(raw.id, now)) return false;
        articles.insert({
          ...outcome.article,
          originalId: raw.id,
          // §5.2 step 7: never auto-publish, whatever the guard decided.
          status: 'pending_review',
          publishedAt: null,
        });
        return true;
      })();

      if (!claimed) {
        report.skipped.push(rawId);
        continue;
      }

      report.simplified.push({
        rawId: raw.id,
        sourceId: raw.sourceId,
        kidHeadline: outcome.article.kidHeadline,
        safety: outcome.article.safety,
        engine: outcome.engine,
        costUsd: outcome.costUsd ?? 0,
        fallbackReason: outcome.fallbackReason,
      });
    } catch (error: unknown) {
      // A database failure on one article leaves simplifiedAt NULL, so the row
      // stays waiting and can be retried. The batch carries on.
      report.failures.push({
        rawId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      done += 1;
      options.onProgress?.(done);
    }
  }

  return report;
}

export interface SimplifyJobState {
  id: string;
  startedAt: string;
  finishedAt?: string;
  rawIds: string[];
  /** How many of rawIds have been attempted, for the progress line. */
  done: number;
  running: boolean;
  report: SimplifyReport;
}

/** Module-level for the same reason as the job lock: one process, one admin. */
let current: SimplifyJobState | null = null;

export function getSimplifyJob(): SimplifyJobState | null {
  return current;
}

/** Test seam: forget any job and let go of the lock. */
export function resetSimplifyJob(): void {
  current = null;
  releaseJob();
}

/**
 * Begin a manual batch and return immediately; the client polls for progress.
 * Fifteen articles is a minute or more of sequential model calls, which is too
 * long to hold an HTTP request open — the same reason scraping works this way.
 */
export function startSimplifyJob(
  db: Database,
  rawIds: string[],
  options: SimplifyOptions & { onFinished?: (state: SimplifyJobState) => void } = {},
): SimplifyJobState {
  if (rawIds.length === 0) throw new BadRequestError('No articles were selected.');

  acquireJob('simplify');

  const state: SimplifyJobState = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    rawIds,
    done: 0,
    running: true,
    report: { simplified: [], failures: [], skipped: [] },
  };
  current = state;

  // Deliberately not awaited: the caller gets the state back straight away.
  void (async () => {
    try {
      state.report = await simplifyRawArticles(db, rawIds, {
        ...options,
        onProgress: (done) => { state.done = done; },
      });
    } catch (error: unknown) {
      state.report.failures.push({
        rawId: '(batch)',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Always: a leaked lock would block every later scrape and batch.
      state.running = false;
      state.finishedAt = new Date().toISOString();
      releaseJob();
      options.onFinished?.(state);
    }
  })();

  return state;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/simplify-service.test.ts && npm run typecheck`
Expected: PASS. Note these tests exercise the local rule-based path, because `LLM_ENABLED` is false in tests and no `client` is passed — that is intentional and matches how `ingestion.test.ts` already works.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/simplifyService.ts server/tests/simplify-service.test.ts
git commit -m "feat(scrape): simplify raw articles on demand, resumable per article"
```

---

## Task 7: Phase 1 — ingestion stores raws only

**Files:**
- Modify: `server/src/ingestion/rssScraper.ts`
- Test: `server/tests/ingestion.test.ts`

**Interfaces:**
- Consumes: Task 2's `RawArticle.simplifiedAt`.
- Produces: the new `ScrapeResult` shape that Task 8 fills in:
  ```ts
  interface ScrapeResult {
    sourceId: string; sourceName: string; ok: boolean; error?: string;
    itemsInFeed: number; skippedNotNew: number; skippedAlreadyStored: number;
    skippedUnusable: number; inserted: number; newestItemPublishedAt: string | null;
    stored: { rawId: string; headline: string; url: string; publishedAt: string | null }[];
    simplified: { rawId: string; kidHeadline: string; safety: string; engine: string }[];
    leftWaiting: number;
    costUsd: number; fallbacks: string[];
  }
  ```

**Expected intermediate state:** after this task a scrape stores raw articles and creates **no** kid articles at all. Task 8 adds the budget phase that puts them back. That is a coherent, tested state — do not try to do both tasks at once.

- [ ] **Step 1: Update the failing tests**

In `server/tests/ingestion.test.ts`, replace the `happy path (§5.2)` test at line 63 and add two new ones:

```ts
  it('stores a raw article per item and simplifies none of them', async () => {
    // §5.2 steps 1-5 only. Steps 6-7 moved to simplifyService, under a budget:
    // a full feed is 40-50 model calls for a queue an editor triages ten of.
    const result = await scrapeSource(ctx.db, bbc());

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(2);
    expect(countRows(ctx.db, 'raw_articles')).toBe(2);
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    expect(result.simplified).toEqual([]);
  });

  it('leaves every stored article waiting', async () => {
    await scrapeSource(ctx.db, bbc());

    const waiting = ctx.db
      .prepare(`SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL`)
      .pluck().get();
    expect(waiting).toBe(2);
  });

  it('reports what it stored, by raw id rather than kid headline', async () => {
    const result = await scrapeSource(ctx.db, bbc());

    expect(result.stored).toHaveLength(2);
    expect(result.stored[0]).toMatchObject({ url: 'https://example.com/1' });
    expect(result.stored[0].rawId).toEqual(expect.any(String));
    expect(result.stored[0].headline).toBe('A rover surveyed the reef');
  });
```

Then delete the old `NEVER auto-publishes` test at line 71 from this file — with no kid articles created here it has nothing to assert, and the equivalent guarantee is covered by `simplify-service.test.ts`'s `creates a pending_review kid article` test and again end-to-end in Task 8. Leave the cursor test at line 80 and every test below it untouched: they assert phase-1 behaviour that has not changed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/ingestion.test.ts`
Expected: FAIL — `kid_articles` count is 2 not 0, and `result.simplified` is undefined.

- [ ] **Step 3: Rewrite the ingestion module**

In `server/src/ingestion/rssScraper.ts`:

Replace the module doc comment's step list:

```ts
/**
 * RSS ingestion — PRD §5.2, in the order the spec lists:
 *   1-2. fetch and parse           -> feedParser.fetchFeed
 *   3.   skip items already seen   -> feedParser.selectNewItems
 *   4.   store raw rows            -> storeItems, below
 *   5.   advance the cursor        -> storeItems, below
 *
 * DIVERGENCE FROM §5.2: the spec's steps 6-7 (guard + simplify + store as
 * pending_review) used to run here, once per item. That made one run 40-50 LLM
 * calls for a queue an editor triages ten of, so they now live in
 * services/simplifyService.ts and run for a budgeted subset only
 * (app_settings.simplifyBudget). Everything is still STORED here; only the
 * spending moved.
 *
 * Written against the generic `sources` table rather than BBC specifically, so
 * enabling another feed in admin settings is all it takes to ingest it.
 */
```

Remove the now-unused imports of `createArticleRepository` and `simplifyArticle`.

Replace the `ScrapeResult` fields:

```ts
  inserted: number;
  newestItemPublishedAt: string | null;
  /** What was stored, for the CLI to print. Raw rows: there is no kid headline yet. */
  stored: { rawId: string; headline: string; url: string; publishedAt: string | null }[];
  /** Filled by the run's simplification phase, not by this module. */
  simplified: { rawId: string; kidHeadline: string; safety: string; engine: string }[];
  /** This source's raws still waiting after the run, filled by phase 2. */
  leftWaiting: number;
  /** Total USD spent on this run, so cost is visible rather than a surprise. */
  costUsd: number;
  /** One entry per article that had to fall back, with the reason (§9.1 step 4). */
  fallbacks: string[];
```

Add the two new fields to `emptyResult`:

```ts
    stored: [],
    simplified: [],
    leftWaiting: 0,
    costUsd: 0,
    fallbacks: [],
```

Replace the whole of `storeItems` — it becomes synchronous:

```ts
/**
 * Steps 4-5, in one transaction. A database failure rolls the whole run back,
 * so the cursor never advances past articles that were not stored.
 *
 * Synchronous now: with simplification moved out there is nothing async left,
 * so the two-pass "prepare then write" dance this used to need is gone.
 */
function storeItems(
  db: Database,
  source: SourceRow,
  items: FeedItem[],
  fetchedAt: string,
  result: ScrapeResult,
): void {
  const rawArticles = createRawArticleRepository(db);
  const sources = createSourceRepository(db);

  db.transaction(() => {
    let newest = source.lastFetchedItemPublishedAt;

    for (const item of items) {
      if (rawArticles.existsForSourceUrl(source.id, item.link)) {
        result.skippedAlreadyStored += 1;
        continue;
      }

      const rawId = randomUUID();
      rawArticles.insert({
        id: rawId,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        url: item.link,
        headline: item.title,
        body: item.body,
        topic: DEFAULT_TOPIC,
        publishedAt: item.publishedAt,
        fetchedAt,
        // The run's simplification phase decides which of these get a model
        // call; the rest wait in the review queue's "not yet simplified" tab.
        simplifiedAt: null,
      });

      result.inserted += 1;
      result.stored.push({
        rawId,
        headline: item.title,
        url: item.link,
        publishedAt: item.publishedAt,
      });

      if (item.publishedAt && (!newest || item.publishedAt > newest)) newest = item.publishedAt;
    }

    // Step 5: advance the cursor to the newest item actually STORED, not the
    // newest merely seen, so a crash mid-run cannot skip items next time.
    // Storing is now unconditional, so nothing is dropped for being unsimplified.
    sources.recordFetch(source.id, fetchedAt, newest);
    result.newestItemPublishedAt = newest;
  })();
}
```

In `scrapeSource`, drop the `await` on `storeItems` (keep the try/catch exactly as it is):

```ts
  try {
    storeItems(db, source, selection.candidates, fetchedAt, result);
    result.ok = true;
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : String(error);
  }
```

Also update the `ScrapeOptions.limit` comment so the two caps cannot be confused:

```ts
export interface ScrapeOptions {
  /**
   * Cap items FETCHED AND STORED in one run, discarding the rest; useful when
   * testing. Not to be confused with app_settings.simplifyBudget, which caps
   * how many STORED items get simplified. This one loses articles; that one
   * only defers them.
   */
  limit?: number;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/ingestion.test.ts && npm run typecheck`
Expected: `ingestion.test.ts` PASSES. Typecheck will FAIL in `scrapeService.ts`, `scrapeRunRepository.ts` and `scripts/scrape.ts`, which still expect the old `stored[]` shape — Task 8 fixes those. If you want a green typecheck before committing, do Tasks 7 and 8 back to back and commit both; otherwise commit with the note below.

- [ ] **Step 5: Commit**

```bash
git add server/src/ingestion/rssScraper.ts server/tests/ingestion.test.ts
git commit -m "refactor(scrape): ingestion stores raw articles and simplifies none

Steps 6-7 of PRD 5.2 move out of the fetch loop. Task 8 wires the budgeted
simplification phase back in; between the two commits a scrape stores only."
```

---

## Task 8: Phase 2 — the two-phase run

**Files:**
- Modify: `server/src/services/scrapeService.ts`
- Modify: `server/src/db/repositories/scrapeRunRepository.ts`
- Modify: `server/src/ingestion/scheduler.ts`
- Modify: `server/scripts/scrape.ts`
- Test: `server/tests/ingestion.test.ts`, `server/tests/scrape-run.test.ts`

**Interfaces:**
- Consumes: `selectBudgetedBatch` + `SourceQueue` (Task 4), `acquireJob`/`releaseJob` (Task 5), `simplifyRawArticles` (Task 6), `waitingIdsBySource`/`countWaitingForSource` (Task 2), `AppSettings.simplifyBudget` (Task 3), the new `ScrapeResult` (Task 7).
- Produces:
  ```ts
  interface RunState {
    id: string; startedAt: string; finishedAt?: string; sourceIds: string[];
    currentSourceId?: string; running: boolean; results: ScrapeResult[];
    trigger: ScrapeTrigger;
    phase: 'fetching' | 'simplifying';
    budget: number;
    /** How many of the batch have been simplified so far. */
    simplifiedCount: number;
  }
  interface StartOptions {
    sourceId?: string; trigger?: ScrapeTrigger; limit?: number;
    /** Overrides app_settings.simplifyBudget; a test seam. */
    budget?: number;
    client?: OpenRouterClient;
    onFinished?: (state: RunState) => void;
  }
  ```
  `summarise(state)` gains `simplified` and `leftWaiting`.
  `ScrapeRun` gains `simplified: number` and `leftWaiting: number`.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/ingestion.test.ts` a new describe block (it needs `startScrapeRun`, so import it from `../src/services/scrapeService.js` and `resetRunState` too):

```ts
describe('the simplification budget', () => {
  /** Runs a full scrape and resolves when the background run has finished. */
  const runToCompletion = (budget?: number) =>
    new Promise<RunState>((resolve) => {
      startScrapeRun(ctx.db, { budget, onFinished: resolve });
    });

  beforeEach(() => {
    resetRunState();
    // 25 items, newest last so the ordering rule is actually exercised.
    feedItems = Array.from({ length: 25 }, (_, i) => ({
      title: `Story number ${i + 1}`,
      link: `https://example.com/story-${i + 1}`,
      pubDate: new Date(Date.UTC(2026, 8, 1, i)).toUTCString(),
      description: 'A calm story about the sea and the coral that lives in it.',
    }));
  });
  afterEach(() => resetRunState());

  it('stores everything but simplifies only the budget', async () => {
    const state = await runToCompletion(10);

    expect(countRows(ctx.db, 'raw_articles')).toBe(25);
    expect(countRows(ctx.db, 'kid_articles')).toBe(10);
    expect(
      ctx.db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL`).pluck().get(),
    ).toBe(15);
    expect(summarise(state).simplified).toBe(10);
  });

  it('advances the cursor past every stored item, not just the simplified ones', async () => {
    // Otherwise the 15 left raw would be re-fetched and re-stored next run.
    await runToCompletion(10);

    const newest = new Date(Date.UTC(2026, 8, 1, 24)).toISOString();
    expect(bbc().lastFetchedItemPublishedAt).toBe(newest);
  });

  it('simplifies the newest stories first', async () => {
    await runToCompletion(3);

    const headlines = ctx.db
      .prepare(`SELECT r.headline FROM raw_articles r WHERE r.simplifiedAt IS NOT NULL`)
      .pluck().all();
    expect(headlines).toEqual(
      expect.arrayContaining(['Story number 25', 'Story number 24', 'Story number 23']),
    );
    expect(headlines).toHaveLength(3);
  });

  it('a second run works through the backlog rather than re-fetching', async () => {
    await runToCompletion(10);
    const state = await runToCompletion(10);

    // Nothing new in the feed, so phase 1 inserts nothing and phase 2 spends
    // the budget on what was left waiting.
    expect(summarise(state).inserted).toBe(0);
    expect(countRows(ctx.db, 'kid_articles')).toBe(20);
    expect(
      ctx.db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL`).pluck().get(),
    ).toBe(5);
  });

  it('a budget of 0 simplifies nothing and still stores everything', async () => {
    await runToCompletion(0);

    expect(countRows(ctx.db, 'raw_articles')).toBe(25);
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
  });

  it('reads the budget from app_settings when none is passed', async () => {
    ctx.db.prepare(`UPDATE app_settings SET simplifyBudget = 2 WHERE id = 'default'`).run();

    await runToCompletion();

    expect(countRows(ctx.db, 'kid_articles')).toBe(2);
  });

  it('still never auto-publishes what it simplifies (§5.2 step 7)', async () => {
    await runToCompletion(5);

    const statuses = ctx.db.prepare(`SELECT DISTINCT status FROM kid_articles`).pluck().all();
    expect(statuses).toEqual(['pending_review']);
  });
});
```

Add to `server/tests/scrape-run.test.ts`:

This file drives its feed with the module-level `itemCount` and waits with `waitForRun()`, both already defined at the top of it. Reuse them:

```ts
  it('records what the run simplified and what it left waiting', async () => {
    // 4 items with a budget of 1: the row must carry both numbers, because the
    // settings page reads the persisted run, not the in-memory state.
    itemCount = 4;

    startScrapeRun(ctx.db, { budget: 1 });
    await waitForRun();

    const run = createScrapeRunRepository(ctx.db).latestPerSource().bbc;
    expect(run.inserted).toBe(4);
    expect(run.simplified).toBe(1);
    expect(run.leftWaiting).toBe(3);
  });

  it('summarises a run by what it stored and what it spent', async () => {
    itemCount = 5;

    const state = startScrapeRun(ctx.db, { budget: 2 });
    await waitForRun();

    expect(summarise(state)).toMatchObject({ inserted: 5, simplified: 2, leftWaiting: 3, failed: 0 });
  });
```

`createScrapeRunRepository`, `startScrapeRun`, `summarise` and `waitForRun` are all already imported or defined in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/ingestion.test.ts tests/scrape-run.test.ts`
Expected: FAIL — `startScrapeRun` has no `budget` option, `summarise(...).simplified` is undefined, `run.simplified` is undefined.

- [ ] **Step 3: Add the run counts to the repository**

In `server/src/db/repositories/scrapeRunRepository.ts`:

```ts
export interface ScrapeRun {
  /* ...existing fields... */
  inserted: number;
  /** Of what this run stored, how many were simplified. */
  simplified: number;
  /** This source's raws still waiting when the run finished. */
  leftWaiting: number;
  /* ...rest unchanged... */
}
```

Add both columns to the INSERT statement's column list and its `VALUES` list, and to the `run` object built inside `record`:

```ts
        inserted: result.inserted,
        simplified: result.simplified.length,
        leftWaiting: result.leftWaiting,
```

- [ ] **Step 4: Rewrite the run service**

Replace `server/src/services/scrapeService.ts` wholesale:

```ts
/**
 * A scrape run — PRD §4.4 "Run now", §5.3 scheduled.
 *
 * Two phases, because §5.2's single pass over every item cost 40-50 LLM calls
 * for a queue an editor triages ten of:
 *
 *   1. fetching     every enabled source is fetched and everything new stored
 *                   as a raw article. Cheap, unbounded, nothing is dropped.
 *   2. simplifying  a budget of app_settings.simplifyBudget articles is spent
 *                   round-robin across sources, newest first. The rest wait.
 *
 * A run starts in the background and the client polls for its state: holding an
 * HTTP request open for minutes invites a proxy timeout.
 *
 * One background job at a time, shared with manual simplification via jobLock —
 * two writers turning the same raw rows into kid articles could double-insert.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { NotFoundError } from '../core/errors.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { createScrapeRunRepository, type ScrapeTrigger } from '../db/repositories/scrapeRunRepository.js';
import { createSettingsRepository } from '../db/repositories/settingsRepository.js';
import { createSourceRepository } from '../db/repositories/sourceRepository.js';
import { scrapeSource, type ScrapeResult, type SourceRow } from '../ingestion/rssScraper.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import { acquireJob, releaseJob } from './jobLock.js';
import { selectBudgetedBatch, type SourceQueue } from './simplifyBudget.js';
import { simplifyRawArticles } from './simplifyService.js';

export interface RunState {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** Sources this run covers, in order. */
  sourceIds: string[];
  /** The source currently being fetched, if any. */
  currentSourceId?: string;
  running: boolean;
  results: ScrapeResult[];
  trigger: ScrapeTrigger;
  /** Which half of the run is happening, so the UI can say which. */
  phase: 'fetching' | 'simplifying';
  /** The budget this run is spending. */
  budget: number;
  /** How many of the batch have been simplified so far. */
  simplifiedCount: number;
}

let current: RunState | null = null;

export function getRunState(): RunState | null {
  return current;
}

/** Test seam: forget any in-flight or finished run and let go of the lock. */
export function resetRunState(): void {
  current = null;
  releaseJob();
}

export interface StartOptions {
  sourceId?: string;
  trigger?: ScrapeTrigger;
  /**
   * Caps items FETCHED per source, discarding the rest. A testing aid: see the
   * warning in scripts/scrape.ts. Distinct from `budget`, which only defers.
   */
  limit?: number;
  /** Overrides app_settings.simplifyBudget. A test seam. */
  budget?: number;
  /** Passed through to simplification; tests and the sandbox use it. */
  client?: OpenRouterClient;
  /** Awaited by tests and the CLI; the HTTP route does not wait. */
  onFinished?: (state: RunState) => void;
}

function failedResult(source: SourceRow, error: unknown): ScrapeResult {
  return {
    sourceId: source.id,
    sourceName: source.name,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    itemsInFeed: 0,
    skippedNotNew: 0,
    skippedAlreadyStored: 0,
    skippedUnusable: 0,
    inserted: 0,
    newestItemPublishedAt: source.lastFetchedItemPublishedAt,
    stored: [],
    simplified: [],
    leftWaiting: 0,
    costUsd: 0,
    fallbacks: [],
  };
}

/**
 * Begin a run and return immediately. Throws ConflictError if a scrape or a
 * manual simplification is already in flight, and NotFoundError for an unknown
 * source.
 */
export function startScrapeRun(db: Database, options: StartOptions = {}): RunState {
  const sources = createSourceRepository(db);

  let queue: SourceRow[];
  if (options.sourceId) {
    const source = sources.findById(options.sourceId);
    if (!source) throw NotFoundError.of('source', options.sourceId);
    // Running a disabled source by name is allowed: the editor asked for it.
    queue = [source];
  } else {
    queue = sources.listEnabled();
  }

  // After the source lookup, so a typo'd source id does not take the lock.
  acquireJob('scrape');

  const state: RunState = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    sourceIds: queue.map((source) => source.id),
    running: true,
    results: [],
    trigger: options.trigger ?? 'manual',
    phase: 'fetching',
    budget: 0,
    simplifiedCount: 0,
  };
  current = state;

  // Deliberately not awaited: the caller gets the state back straight away.
  void (async () => {
    const runs = createScrapeRunRepository(db);
    const raws = createRawArticleRepository(db);
    const timings = new Map<string, { startedAt: string; finishedAt: string }>();

    try {
      // ─── Phase 1: fetch and store. Cheap, and nothing is discarded. ─────
      for (const source of queue) {
        state.currentSourceId = source.id;
        const startedAt = new Date().toISOString();

        // scrapeSource never throws, but a database failure here would kill
        // the loop, so it is caught rather than trusted.
        let result: ScrapeResult;
        try {
          result = await scrapeSource(db, source, { limit: options.limit });
        } catch (error: unknown) {
          result = failedResult(source, error);
        }

        state.results.push(result);
        timings.set(source.id, { startedAt, finishedAt: new Date().toISOString() });
      }
      state.currentSourceId = undefined;

      // ─── Phase 2: spend the budget, round-robin, newest first. ──────────
      // Runs over the whole backlog, not just this run's inserts, so articles
      // left waiting by an earlier run get their turn.
      state.phase = 'simplifying';
      state.budget = options.budget ?? createSettingsRepository(db).getAppSettings().simplifyBudget;

      const waiting = raws.waitingIdsBySource();
      // Ordered by the run's own source list, so allocation is deterministic
      // and a source that failed to fetch cannot jump the queue.
      const queues = state.sourceIds
        .map((sourceId) => waiting.find((group) => group.sourceId === sourceId))
        .filter((group): group is SourceQueue => group !== undefined);

      const batch = selectBudgetedBatch(queues, state.budget);
      const report = await simplifyRawArticles(db, batch, {
        client: options.client,
        onProgress: (done) => { state.simplifiedCount = done; },
      });

      // Attribute each article's outcome back to the source it came from.
      for (const row of report.simplified) {
        const result = state.results.find((r) => r.sourceId === row.sourceId);
        if (!result) continue;
        result.simplified.push({
          rawId: row.rawId,
          kidHeadline: row.kidHeadline,
          safety: row.safety,
          engine: row.engine,
        });
        result.costUsd += row.costUsd;
        if (row.fallbackReason) result.fallbacks.push(row.fallbackReason);
      }

      // Counted, not subtracted: phase 2 may have cleared backlog from an
      // earlier run, so this run's `inserted` is not the right basis.
      for (const result of state.results) {
        result.leftWaiting = raws.countWaitingForSource(result.sourceId);
      }

      // Recorded now rather than per source, because the simplification counts
      // are not known until the budget has been spent.
      for (const result of state.results) {
        const timing = timings.get(result.sourceId);
        if (!timing) continue;
        try {
          runs.record(result, { ...timing, trigger: state.trigger });
        } catch (error: unknown) {
          console.error('[scrape] could not record the run:', error);
        }
      }
    } catch (error: unknown) {
      // Without this the run would stay `running: true` forever, which is the
      // bug the old un-caught IIFE had.
      console.error('[scrape] run failed:', error instanceof Error ? error.message : error);
    } finally {
      state.currentSourceId = undefined;
      state.finishedAt = new Date().toISOString();
      state.running = false;
      releaseJob();
      options.onFinished?.(state);
    }
  })();

  return state;
}

/** Totals for the UI. */
export function summarise(state: RunState) {
  return {
    inserted: state.results.reduce((total, r) => total + r.inserted, 0),
    simplified: state.results.reduce((total, r) => total + r.simplified.length, 0),
    leftWaiting: state.results.reduce((total, r) => total + r.leftWaiting, 0),
    failed: state.results.filter((r) => !r.ok).length,
    costUsd: state.results.reduce((total, r) => total + r.costUsd, 0),
  };
}
```

- [ ] **Step 5: Update the CLI report**

In `server/scripts/scrape.ts`, replace the counts block and the stored listing inside `report`:

```ts
  console.log(`  items in feed        ${result.itemsInFeed}`);
  console.log(`  skipped (not new)    ${result.skippedNotNew}`);
  console.log(`  skipped (duplicate)  ${result.skippedAlreadyStored}`);
  console.log(`  skipped (unusable)   ${result.skippedUnusable}`);
  console.log(`  STORED (raw)         ${result.inserted}`);
  console.log(`  SIMPLIFIED           ${result.simplified.length}`);
  console.log(`  still waiting        ${result.leftWaiting}`);
  console.log(`  cursor now at        ${result.newestItemPublishedAt ?? '(none)'}`);

  if (result.simplified.length > 0) {
    console.log('\n  Simplified, now pending_review:');
    for (const item of result.simplified) {
      console.log(`    [${item.safety.padEnd(12)}] ${item.kidHeadline}`);
    }
  }

  if (result.leftWaiting > 0) {
    console.log(
      `\n  ${result.leftWaiting} article(s) stored raw. Simplify them from` +
        ` /admin/review → "Not yet simplified", or raise the budget in /admin/settings.`,
    );
  }
```

Also add the budget to the usage comment at the top of the file:

```ts
 *   npm run scrape -- --budget 3     simplify at most 3 this run
```

and read it in `main` beside the existing `--limit` handling, which it mirrors:

```ts
    const budgetArg = flag('budget');
    const budget = budgetArg === undefined ? undefined : Number(budgetArg);
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 0)) {
      throw new Error(`--budget must be a whole number, got '${budgetArg}'.`);
    }
```

then pass it through the existing `startScrapeRun` call:

```ts
        startScrapeRun(db, { sourceId, limit, budget, trigger: 'manual', onFinished: resolve });
```

and extend the totals footer, which currently reports `inserted` alone:

```ts
    const inserted = results.reduce((total, r) => total + r.inserted, 0);
    const simplified = results.reduce((total, r) => total + r.simplified.length, 0);
    const failed = results.filter((r) => !r.ok);

    console.log('─'.repeat(78));
    console.log(
      `Total stored: ${inserted}   Simplified: ${simplified}   Sources failed: ${failed.length}`,
    );
    console.log('Everything simplified is status = pending_review (§5.2 step 7).');
```

- [ ] **Step 6: Say what the scheduled run spent**

`server/src/ingestion/scheduler.ts` already compiles unchanged — every field its log reads still exists — but the daily log is the only place an operator sees a scheduled run, so it should report the spend. In `runScheduledScrape`, extend the success branch:

```ts
        console.log(
          `[scrape] ${result.sourceId}: ${result.inserted} stored, ` +
            `${result.simplified.length} simplified, ${result.leftWaiting} waiting, ` +
            `${result.skippedNotNew} already seen, ${result.skippedAlreadyStored} duplicate, ` +
            `${result.skippedUnusable} unusable (of ${result.itemsInFeed} in feed)`,
        );
```

- [ ] **Step 7: Run the whole suite**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS, everything. `scrape-run.test.ts`'s existing `/already running/` assertions at lines 104 and 215 must still pass — the jobLock messages were written to keep them green. `scripts/scrape.ts` is the only other consumer of `ScrapeResult.stored`, and Step 5 fixed it; `try-pipeline.ts` and `check-llm.ts` read `kidHeadline` off `simplifyArticle` directly and are unaffected.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/scrapeService.ts server/src/db/repositories/scrapeRunRepository.ts \
        server/src/ingestion/scheduler.ts server/scripts/scrape.ts \
        server/tests/ingestion.test.ts server/tests/scrape-run.test.ts
git commit -m "feat(scrape): spend a budgeted simplification phase after fetching"
```

---

## Task 9: The HTTP surface

**Files:**
- Create: `server/src/routes/admin/rawArticles.ts`
- Modify: `server/src/routes/admin/prompts.ts:27-38` (move the endpoint out)
- Modify: `server/src/routes/admin/articleQueue.ts:26-29` (add `waiting`)
- Modify: `server/src/app.ts:16-33` (mount the router)
- Test: `server/tests/admin-raw-articles.test.ts`, `server/tests/admin-queue.test.ts`

**Interfaces:**
- Consumes: `listWaiting`/`countWaiting` (Task 2), `startSimplifyJob`/`getSimplifyJob` (Task 6).
- Produces:
  ```
  GET  /api/admin/raw-articles                    (moved, unchanged)
  GET  /api/admin/raw-articles/waiting            -> { articles: WaitingRawArticle[], total: number }
  GET  /api/admin/raw-articles/simplify/status    -> { running: boolean, job: SimplifyJobState | null }
  POST /api/admin/raw-articles/simplify           { ids: string[] } -> 202 same shape
  GET  /api/admin/articles/counts                 -> { ...statuses, total, waiting }
  ```

- [ ] **Step 1: Write the failing tests**

Create `server/tests/admin-raw-articles.test.ts`:

```ts
/**
 * The raw-article backlog API: what is waiting, and simplifying it on demand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRawArticleRepository } from '../src/db/repositories/rawArticleRepository.js';
import { resetSimplifyJob, type SimplifyJobState } from '../src/services/simplifyService.js';
import { countRows, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

const seedWaiting = (id: string, over: Record<string, unknown> = {}) => {
  createRawArticleRepository(ctx.db).insert({
    id, sourceId: 'bbc', sourceName: 'BBC News', sourceUrl: 'https://feed',
    url: `https://example.com/${id}`, headline: `Adult headline ${id}`,
    body: 'A rover surveyed the reef and found the coral healthy this year.',
    topic: 'World', publishedAt: '2026-09-08T00:00:00.000Z',
    fetchedAt: '2026-09-08T01:00:00.000Z', simplifiedAt: null, ...over,
  });
};

/** Polls the job endpoint until the batch reports itself finished. */
async function waitForJob(): Promise<{ running: boolean; job: SimplifyJobState }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await (await ctx.api('/api/admin/raw-articles/simplify/status')).json();
    if (body.job && !body.running) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the simplification job never finished');
}

beforeEach(() => { ctx = createTestContext(); resetSimplifyJob(); });
afterEach(() => { ctx.close(); resetSimplifyJob(); });

describe('GET /api/admin/raw-articles/waiting', () => {
  it('needs admin auth', async () => {
    expect((await ctx.anon('/api/admin/raw-articles/waiting')).status).toBe(401);
  });

  it('lists unsimplified articles with a total', async () => {
    seedWaiting('r1');
    seedWaiting('r2', { simplifiedAt: '2026-09-09T00:00:00.000Z' });

    const body = await (await ctx.api('/api/admin/raw-articles/waiting')).json();

    expect(body.total).toBe(1);
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0]).toMatchObject({
      id: 'r1', sourceId: 'bbc', sourceName: 'BBC News', headline: 'Adult headline r1',
    });
    expect(body.articles[0].bodyLength).toBeGreaterThan(0);
  });

  it('filters by source and caps the limit', async () => {
    seedWaiting('r1');
    seedWaiting('m1', { sourceId: 'manual', sourceName: 'Manual submission' });

    const filtered = await (await ctx.api('/api/admin/raw-articles/waiting?source=manual')).json();
    expect(filtered.articles.map((a: { id: string }) => a.id)).toEqual(['m1']);

    // A caller asking for a million rows gets the ceiling, not a million rows.
    const capped = await (await ctx.api('/api/admin/raw-articles/waiting?limit=100000')).json();
    expect(capped.articles.length).toBeLessThanOrEqual(200);
  });
});

describe('POST /api/admin/raw-articles/simplify', () => {
  it('starts a background job and simplifies exactly the ids given', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    const res = await ctx.api('/api/admin/raw-articles/simplify', {
      method: 'POST',
      body: JSON.stringify({ ids: ['r1'] }),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).running).toBe(true);

    const finished = await waitForJob();
    expect(finished.job.report.simplified).toHaveLength(1);
    expect(countRows(ctx.db, 'kid_articles')).toBe(1);
    // r2 was not selected, so it is still waiting.
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);
  });

  it('rejects a missing or empty selection', async () => {
    for (const body of [{}, { ids: [] }, { ids: 'r1' }, { ids: [1, 2] }]) {
      const res = await ctx.api('/api/admin/raw-articles/simplify', {
        method: 'POST', body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('returns 409 while a batch is already running', async () => {
    seedWaiting('r1');
    seedWaiting('r2');

    await ctx.api('/api/admin/raw-articles/simplify', {
      method: 'POST', body: JSON.stringify({ ids: ['r1'] }),
    });
    const second = await ctx.api('/api/admin/raw-articles/simplify', {
      method: 'POST', body: JSON.stringify({ ids: ['r2'] }),
    });

    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already running/);
    await waitForJob();
  });

  it('needs admin auth', async () => {
    const res = await ctx.anon('/api/admin/raw-articles/simplify', {
      method: 'POST', body: JSON.stringify({ ids: ['r1'] }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/raw-articles', () => {
  it('still serves the sandbox test-article dropdown after the move', async () => {
    seedWaiting('r1');
    const body = await (await ctx.api('/api/admin/raw-articles')).json();
    expect(body.map((a: { id: string }) => a.id)).toContain('r1');
  });
});
```

Add to `server/tests/admin-queue.test.ts`:

```ts
  it('counts what is waiting to be simplified alongside the status tabs', async () => {
    createRawArticleRepository(ctx.db).insert({
      id: 'waiting-1', sourceId: 'bbc', sourceName: 'BBC News', sourceUrl: 'https://feed',
      url: 'https://example.com/w', headline: 'Adult headline', body: 'Body text',
      topic: 'World', publishedAt: null, fetchedAt: '2026-09-08T00:00:00.000Z',
      simplifiedAt: null,
    });

    const counts = await (await ctx.api('/api/admin/articles/counts')).json();
    expect(counts.waiting).toBe(1);
    // The status counts must be untouched by the addition.
    expect(counts).toHaveProperty('pending_review');
    expect(counts).toHaveProperty('total');
  });
```

Import `createRawArticleRepository` into `admin-queue.test.ts`. `ctx.api` from `helpers.ts` already sends the admin credentials, so `ADMIN_AUTH` is deliberately not imported above; `ctx.anon` is the unauthenticated one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/admin-raw-articles.test.ts tests/admin-queue.test.ts`
Expected: FAIL — 404 on `/raw-articles/waiting`, `counts.waiting` undefined.

- [ ] **Step 3: Create the router**

Create `server/src/routes/admin/rawArticles.ts`:

```ts
/**
 * The raw-article backlog — articles a scrape stored but did not spend its
 * simplification budget on — and simplifying them on demand.
 *
 * A single article is one model call, but an editor can select fifteen, which
 * is a minute or more of sequential calls. So POST starts a background job and
 * the client polls, the same shape as §4.4's "Run now".
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../../core/errors.js';
import { createRawArticleRepository } from '../../db/repositories/rawArticleRepository.js';
import { getSimplifyJob, startSimplifyJob } from '../../services/simplifyService.js';

/** A ceiling, so one request cannot ask for the entire table. */
const MAX_LIST = 200;
const DEFAULT_LIST = 50;

export function createRawArticlesRouter(db: Database): Router {
  const router = Router();
  const raws = createRawArticleRepository(db);

  const jobResponse = () => {
    const job = getSimplifyJob();
    return { running: job?.running ?? false, job };
  };

  /** §7.6: recent raw articles for the sandbox's test-article dropdown. */
  router.get('/raw-articles', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
    res.json(
      db
        .prepare(
          `SELECT r.id, r.headline, r.sourceName, r.topic, r.publishedAt, r.fetchedAt,
                  LENGTH(r.body) AS bodyLength
           FROM raw_articles r ORDER BY r.fetchedAt DESC LIMIT ?`,
        )
        .all(limit),
    );
  });

  /** The backlog: stored, never simplified. Newest first, undated last. */
  router.get('/raw-articles/waiting', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? DEFAULT_LIST) || DEFAULT_LIST, MAX_LIST);
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';

    res.json({
      articles: raws.listWaiting({ sourceId: source || undefined, limit }),
      // The unfiltered total, so the tab badge and the list agree.
      total: raws.countWaiting(),
    });
  });

  router.get('/raw-articles/simplify/status', (_req, res) => {
    res.json(jobResponse());
  });

  /** Returns straight away; poll /raw-articles/simplify/status. */
  router.post('/raw-articles/simplify', (req, res) => {
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
      throw new BadRequestError('ids must be a non-empty array of raw article ids.');
    }

    startSimplifyJob(db, ids as string[]);
    res.status(202).json(jobResponse());
  });

  return router;
}
```

- [ ] **Step 4: Wire it up and remove the duplicate**

In `server/src/routes/admin/prompts.ts`, delete the `router.get('/raw-articles', ...)` handler and its `/** §7.6 ... */` comment. Leave everything else alone.

In `server/src/routes/admin/articleQueue.ts`, add the import and extend the counts route:

```ts
import { createRawArticleRepository } from '../../db/repositories/rawArticleRepository.js';
// ...inside createArticleQueueRouter, beside the other repositories:
  const rawArticles = createRawArticleRepository(db);

  /** §4.2: a count badge per status tab, plus the backlog tab's own. */
  router.get('/articles/counts', (_req, res) => {
    res.json({ ...articles.countsByStatus(), waiting: rawArticles.countWaiting() });
  });
```

In `server/src/app.ts`, import and mount the router before the actions router:

```ts
import { createRawArticlesRouter } from './routes/admin/rawArticles.js';
// ...in ADMIN_ROUTERS, before createArticleActionsRouter:
  createRawArticlesRouter,
```

- [ ] **Step 5: Run the whole suite**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. `admin-sandbox.test.ts` and any prompts test that hits `/raw-articles` must still pass — the URL did not change, only which module serves it.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/admin/rawArticles.ts server/src/routes/admin/prompts.ts \
        server/src/routes/admin/articleQueue.ts server/src/app.ts \
        server/tests/admin-raw-articles.test.ts server/tests/admin-queue.test.ts
git commit -m "feat(api): expose the waiting backlog and on-demand simplification"
```

---

## Task 10: The "Not yet simplified" tab

**Files:**
- Create: `web/src/pages/admin/review/WaitingPanel.tsx`
- Modify: `web/src/admin/types.ts`
- Modify: `web/src/pages/admin/AdminReview.tsx`
- Test: `web/src/__tests__/admin-waiting.test.tsx`

**Interfaces:**
- Consumes: Task 9's four endpoints.
- Produces:
  ```ts
  interface StatusCounts { pending_review; published; rejected; total; waiting: number }
  interface WaitingRawArticle {
    id: string; sourceId: string; sourceName: string; headline: string; url: string;
    topic: string; publishedAt: string | null; fetchedAt: string; bodyLength: number;
  }
  interface SimplifyJob {
    id: string; startedAt: string; finishedAt?: string; rawIds: string[];
    done: number; running: boolean;
    report: {
      simplified: { rawId: string; kidHeadline: string }[];
      failures: { rawId: string; error: string }[];
      skipped: string[];
    };
  }
  function WaitingPanel(props: {
    sources: { id: string; name: string }[];
    onSimplified: () => Promise<void> | void;
  }): JSX.Element
  ```

**Decomposition note:** `AdminReview.tsx` is already ~290 lines holding eleven pieces of state, all of it about kid articles. Rather than thread a fourth, differently-shaped tab through it, `WaitingPanel` owns its own loading, selection, notices and polling; `AdminReview` gains only the tab button and a branch. This is why `FilterBar` and `BulkBar` need no changes at all — the panel renders its own minimal source filter and action bar.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/admin-waiting.test.tsx`:

```tsx
/**
 * The review queue's "Not yet simplified" tab.
 *
 * These raw rows are the articles a scrape stored but did not spend its budget
 * on, so the safety-relevant point is what they are NOT: they carry no kid
 * headline, no safety verdict, and cannot be approved from here.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminReview } from '../pages/admin/AdminReview';
import type { WaitingRawArticle } from '../admin/types';

const RAW: WaitingRawArticle = {
  id: 'r1', sourceId: 'bbc', sourceName: 'BBC News',
  headline: 'Adult headline about the reef', url: 'https://example.com/1',
  topic: 'World', publishedAt: '2026-09-08T10:00:00.000Z',
  fetchedAt: '2026-09-08T11:00:00.000Z', bodyLength: 1400,
};
const raw = (over: Partial<WaitingRawArticle> = {}): WaitingRawArticle => ({ ...RAW, ...over });

let waiting: WaitingRawArticle[] = [];
let simplifyBody: { ids: string[] } | null = null;
let jobRunning = false;

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url);
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    if (path.includes('/raw-articles/simplify/status')) {
      return json({
        running: jobRunning,
        job: {
          id: 'j1', startedAt: '', rawIds: simplifyBody?.ids ?? [], done: jobRunning ? 1 : 2,
          running: jobRunning,
          report: {
            simplified: jobRunning ? [] : (simplifyBody?.ids ?? []).map((rawId) => ({ rawId, kidHeadline: 'Kid headline' })),
            failures: [], skipped: [],
          },
        },
      });
    }
    if (path.includes('/raw-articles/simplify')) {
      simplifyBody = JSON.parse(String(init.body));
      jobRunning = true;
      return json({ running: true, job: { id: 'j1', done: 0, running: true, rawIds: simplifyBody!.ids, startedAt: '', report: { simplified: [], failures: [], skipped: [] } } }, 202);
    }
    if (path.includes('/raw-articles/waiting')) {
      return json({ articles: waiting, total: waiting.length });
    }
    if (path.includes('/articles/counts')) {
      return json({ pending_review: 2, published: 0, rejected: 0, total: 2, waiting: waiting.length });
    }
    if (path.includes('/articles/filters')) {
      return json({ categories: [], sources: [{ id: 'bbc', name: 'BBC News' }], ageTargets: [], safety: [], statuses: [], sortFields: [] });
    }
    if (path.includes('/articles')) return json({ articles: [], total: 0 });
    return json({});
  }));
}

const view = () =>
  render(
    <MemoryRouter>
      <AdminAuthProvider>
        <AdminReview />
      </AdminAuthProvider>
    </MemoryRouter>,
  );

/** Switches to the backlog tab and waits for its first load. */
async function openTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /not yet simplified/i }));
  await waitFor(() => expect(screen.getByText(RAW.headline)).toBeInTheDocument());
}

beforeEach(() => {
  waiting = [raw()];
  simplifyBody = null;
  jobRunning = false;
  // sessionStorage, key 'news4littles.admin' — the same as admin-review.test.tsx.
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('the waiting tab', () => {
  it('shows a count badge from the counts endpoint', async () => {
    waiting = [raw(), raw({ id: 'r2' })];
    view();
    const tab = await screen.findByRole('button', { name: /not yet simplified/i });
    await waitFor(() => expect(within(tab).getByText('2')).toBeInTheDocument());
  });

  it('lists the original adult headline, source and size', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    expect(screen.getByText(/BBC News/)).toBeInTheDocument();
    // No kid headline and no safety badge exist yet for a raw article.
    expect(screen.queryByText(/Kid headline/)).not.toBeInTheDocument();
  });

  it('posts the selected ids when one row is simplified', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByRole('button', { name: /^simplify$/i }));

    await waitFor(() => expect(simplifyBody).toEqual({ ids: ['r1'] }));
  });

  it('posts every selected id for a bulk simplify', async () => {
    waiting = [raw(), raw({ id: 'r2', headline: 'Second adult headline' })];
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByLabelText(/select all/i));
    await user.click(screen.getByRole('button', { name: /simplify 2 selected/i }));

    await waitFor(() => expect(simplifyBody).toEqual({ ids: ['r1', 'r2'] }));
  });

  it('shows progress while the job runs, then reports the result', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByRole('button', { name: /^simplify$/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/simplifying/i));

    // The job finishes and the panel reloads: the row is gone from the backlog.
    jobRunning = false;
    waiting = [];
    await waitFor(
      () => expect(screen.getByText(/1 article\(s\) simplified/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it('never sends status=waiting to the article query', async () => {
    // 'waiting' is not a kid_articles status; the API rejects it with a 400.
    const user = userEvent.setup();
    view();
    await openTab(user);

    const fetchMock = vi.mocked(fetch);
    const queried = fetchMock.mock.calls.map(([url]) => String(url));
    expect(queried.some((url) => url.includes('status=waiting'))).toBe(false);
  });
});
```

The auth setup above matches `AdminAuthContext.tsx`: credentials live in **sessionStorage** under `news4littles.admin` as base64 `username:password` (see `STORAGE_KEY` there). `admin-review.test.tsx:70` does exactly the same.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/admin-waiting.test.tsx`
Expected: FAIL — no button matching `/not yet simplified/i`.

- [ ] **Step 3: Add the web types**

In `web/src/admin/types.ts`:

```ts
export interface StatusCounts {
  pending_review: number;
  published: number;
  rejected: number;
  total: number;
  /** Raw articles stored but not yet simplified — the fourth tab's badge. */
  waiting: number;
}

/** A raw article waiting for its simplification (no kid fields exist yet). */
export interface WaitingRawArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  headline: string;
  url: string;
  topic: string;
  publishedAt: string | null;
  fetchedAt: string;
  bodyLength: number;
}

/** A background simplification batch, as the status endpoint reports it. */
export interface SimplifyJob {
  id: string;
  startedAt: string;
  finishedAt?: string;
  rawIds: string[];
  done: number;
  running: boolean;
  report: {
    simplified: { rawId: string; kidHeadline: string }[];
    failures: { rawId: string; error: string }[];
    skipped: string[];
  };
}
```

- [ ] **Step 4: Build the panel**

Create `web/src/pages/admin/review/WaitingPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useAdminAuth } from '../../../admin/AdminAuthContext';
import { ErrorState, LoadingState } from '../../../components/States';
import { Button } from '../../../ui/Button';
import { Select, TextInput } from '../../../ui/Field';
import { Notice } from '../../../ui/Surface';
import type { SimplifyJob, WaitingRawArticle } from '../../../admin/types';

const POLL_MS = 2000;
/** One request covers the realistic backlog; the API caps at 200 regardless. */
const PAGE_SIZE = 200;

/**
 * The review queue's "Not yet simplified" tab.
 *
 * A scrape stores every article it finds but only simplifies
 * app_settings.simplifyBudget of them, so these are the leftovers: real stories
 * with no kid version yet, costing nothing until an editor asks for one.
 *
 * Owns its own loading, selection and polling. The queue's own state is all
 * about kid articles, and threading a differently-shaped tab through it would
 * mean four states meaning different things depending on the tab.
 */
export function WaitingPanel({
  sources, onSimplified,
}: {
  sources: { id: string; name: string }[];
  onSimplified: () => Promise<void> | void;
}) {
  const { adminFetch } = useAdminAuth();

  const [rows, setRows] = useState<WaitingRawArticle[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<SimplifyJob | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (sourceId) params.set('source', sourceId);

      const res = await adminFetch(`/api/admin/raw-articles/waiting?${params.toString()}`);
      if (!res.ok) throw new Error('Could not load the backlog.');

      const body = (await res.json()) as { articles: WaitingRawArticle[]; total: number };
      setRows(body.articles);
      setTotal(body.total);
      setSelected(new Set());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load the backlog.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch, sourceId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Polls while a batch runs. Fifteen articles is a minute of model calls, so
   * the request that starts it returns immediately and this watches instead.
   */
  useEffect(() => {
    if (!job?.running) return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await adminFetch('/api/admin/raw-articles/simplify/status');
          if (!res.ok) return;

          const body = (await res.json()) as { running: boolean; job: SimplifyJob | null };
          setJob(body.job);
          if (body.running || !body.job) return;

          const done = body.job.report.simplified.length;
          const failed = body.job.report.failures.length;
          setNotice(
            `${done} article(s) simplified and waiting in Pending review` +
              (failed > 0 ? `, ${failed} could not be simplified and are still here.` : '.'),
          );
          await load();
          await onSimplified();
        } catch {
          // A dropped poll is retried on the next tick.
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [job?.running, adminFetch, load, onSimplified]);

  async function simplify(ids: string[]) {
    setNotice(null);
    try {
      const res = await adminFetch('/api/admin/raw-articles/simplify', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(`⚠ ${body.error ?? 'Could not start simplifying.'}`);
        return;
      }
      setJob(((await res.json()) as { job: SimplifyJob }).job);
    } catch {
      setNotice('⚠ Could not reach the server. Check it is running, then try again.');
    }
  }

  // Filtered in the browser: one page covers the backlog, and this keeps the
  // endpoint to one query parameter.
  const visible = search.trim()
    ? rows.filter((row) => row.headline.toLowerCase().includes(search.trim().toLowerCase()))
    : rows;

  const running = job?.running ?? false;
  const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.id));

  return (
    <div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-bold">Source</span>
          <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>{source.name}</option>
            ))}
          </Select>
        </label>
        <label className="block flex-1 min-w-48">
          <span className="text-sm font-bold">Search headlines</span>
          <TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="reef" />
        </label>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        Stories a scrape stored but did not simplify. They cost nothing while they wait.
        Simplifying one sends it to the model and puts it in Pending review.
      </p>

      {notice && <div className="mt-4"><Notice>{notice}</Notice></div>}

      {running && job && (
        <div className="mt-4" role="status">
          <Notice>Simplifying {job.done} of {job.rawIds.length}… this takes a few seconds each.</Notice>
        </div>
      )}

      <div className="mt-5">
        {loading && <LoadingState label="Loading the backlog…" />}
        {error && !loading && <ErrorState message={error} />}

        {!loading && !error && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-3">
              <label className="flex items-center gap-2 text-sm font-bold">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={visible.length === 0 || running}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(visible.map((row) => row.id)) : new Set())
                  }
                />
                Select all {visible.length > 0 && `(${visible.length} shown)`}
              </label>

              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">{total} waiting</span>
                <Button
                  size="sm"
                  disabled={selected.size === 0 || running}
                  onClick={() => void simplify([...selected])}
                >
                  <Sparkles className="w-3.5 h-3.5" /> Simplify {selected.size} selected
                </Button>
              </div>
            </div>

            {visible.length === 0 ? (
              <p className="rounded-3xl border border-border bg-card px-6 py-14 text-center text-muted-foreground">
                Nothing is waiting. Every stored article has been simplified.
              </p>
            ) : (
              <div className="space-y-3">
                {visible.map((row) => (
                  <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.headline}`}
                      checked={selected.has(row.id)}
                      disabled={running}
                      onChange={(e) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        })
                      }
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold">{row.headline}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.sourceName} · {row.topic} ·{' '}
                        {row.publishedAt ? new Date(row.publishedAt).toLocaleString() : 'no date'} ·{' '}
                        {row.bodyLength} characters
                        {row.bodyLength < 200 && (
                          <span className="text-amber-700"> · very short, may be a stub</span>
                        )}
                      </p>
                    </div>

                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm underline hover:no-underline"
                    >
                      Read the original
                    </a>

                    <Button
                      size="sm"
                      variant="outline"
                      disabled={running}
                      onClick={() => void simplify([row.id])}
                    >
                      <Sparkles className="w-3.5 h-3.5" /> Simplify
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add the tab to `AdminReview`**

In `web/src/pages/admin/AdminReview.tsx`:

Extend `TABS` and derive its key type:

```tsx
const TABS = [
  { key: 'pending_review', label: 'Pending review' },
  { key: 'published', label: 'Published' },
  { key: 'rejected', label: 'Rejected' },
  // Not a kid_articles status — raw articles a scrape stored but did not
  // simplify. It must never reach the article query as a status filter.
  { key: 'waiting', label: 'Not yet simplified' },
] as const;

type TabKey = (typeof TABS)[number]['key'];
```

Add the tab state beside the existing state:

```tsx
  const [tab, setTab] = useState<TabKey>('pending_review');
```

Split the counts fetch out of `load`, so the badge still refreshes on the backlog tab:

```tsx
  const loadCounts = useCallback(async () => {
    try {
      const res = await adminFetch('/api/admin/articles/counts');
      if (res.ok) setCounts((await res.json()) as StatusCounts);
    } catch {
      // The badges are cosmetic; the queue works without them.
    }
  }, [adminFetch]);

  const load = useCallback(async () => {
    // The backlog tab loads its own rows; this query is kid articles only.
    if (tab === 'waiting') {
      await loadCounts();
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const listRes = await adminFetch(`/api/admin/articles${query}`);
      if (!listRes.ok) {
        throw new Error(((await listRes.json()) as { error?: string }).error ?? 'Could not load articles.');
      }
      setArticles(((await listRes.json()) as { articles: AdminArticle[] }).articles);
      await loadCounts();
      setSelected(new Set());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load articles.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch, query, tab, loadCounts]);
```

Change the tab button's `active` check and `onClick`:

```tsx
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key);
                // Only real statuses go into the query.
                if (t.key !== 'waiting') setFilters({ ...filters, status: t.key });
              }}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition ${
                active ? 'bg-primary text-primary-foreground' : 'text-foreground/70 hover:bg-muted'
              }`}
            >
              {t.label}
              <span className={`rounded-full px-2 py-0.5 text-xs ${active ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
                {counts ? counts[t.key] : '–'}
              </span>
            </button>
          );
        })}
```

Wrap everything from `<FilterBar .../>` down to the end of the article list in the branch, and import the panel:

```tsx
import { WaitingPanel } from './review/WaitingPanel';
// ...directly after the tab bar's closing </div>:
      {tab === 'waiting' ? (
        <WaitingPanel sources={options?.sources ?? []} onSimplified={loadCounts} />
      ) : (
        <>
          {/* the existing FilterBar, notice, BulkBar, SkippedReport and list */}
        </>
      )}
```

Keep the dialogs (`RejectDialog`, `EditDialog`, `ViewArticleDialog`, `ConfirmDialog`, `RegenerateDialog`) **outside** the branch, where they are now — they are shared and none of them applies to a raw row, but moving them would change unrelated behaviour.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS, including the existing `admin-review.test.tsx`. Its counts mock returns no `waiting` key, so the badge renders `undefined`; if a test asserts on the exact badge text, add `waiting: 0` to that file's counts mock rather than changing the component.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/admin/review/WaitingPanel.tsx web/src/admin/types.ts \
        web/src/pages/admin/AdminReview.tsx web/src/__tests__/admin-waiting.test.tsx \
        web/src/__tests__/admin-review.test.tsx
git commit -m "feat(admin): add a Not yet simplified tab to the review queue"
```

---

## Task 11: Settings UI — the budget input and the run summary

**Files:**
- Modify: `web/src/pages/admin/settings/types.ts`
- Modify: `web/src/pages/admin/settings/AppSettingsSection.tsx`
- Modify: `web/src/pages/admin/settings/ScrapeControls.tsx`
- Test: `web/src/__tests__/admin-step7.test.tsx`

**Interfaces:**
- Consumes: Task 3's `simplifyBudget` on `GET/PUT /app-settings`, Task 8's `ScrapeRun.simplified` / `.leftWaiting` and `RunState.phase` / `.budget` / `.simplifiedCount`.
- Produces: no new exports; a number input and two extra numbers in the summary line.

- [ ] **Step 1: Write the failing test**

First extend two mock responses inside this file's `mockApi`, or the new tests fail for the wrong reason. The `/app-settings` line becomes:

```tsx
    if (path.includes('/app-settings')) return json({ defaultAge: 6, scrapeTimes: ['06:00'], llmProvider: null, simplifyBudget: 10, apiKeyLocation: 'environment variable only (never stored in the database)' });
```

and the `lastRuns.bbc` object inside the `/scrape/status` response gains the two counts, set to the numbers this feature exists to produce:

```tsx
          itemsInFeed: 45, inserted: 41, simplified: 10, leftWaiting: 31,
          skippedNotNew: 4, skippedAlreadyStored: 0,
```

Then add both tests to the settings `describe` block. `renderIn`, `AdminSettings` and `calls` are already defined in this file:

```tsx
  it('saves the simplification budget', async () => {
    const user = userEvent.setup();
    renderIn(<AdminSettings />);

    const input = await screen.findByLabelText(/simplifications per scrape run/i);
    await user.clear(input);
    await user.type(input, '4');
    await user.click(screen.getByRole('button', { name: /save app settings/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.path.includes('/app-settings') && call.method === 'PUT');
      expect(put?.body.simplifyBudget).toBe(4);
    });
  });

  it('shows how much of a run was simplified and how much was left raw', async () => {
    renderIn(<AdminSettings />);

    // The point of the whole feature, on one line: 41 stored, 10 paid for.
    expect(await screen.findByText(/10 simplified/)).toBeInTheDocument();
    expect(screen.getByText(/31 still raw/)).toBeInTheDocument();
  });
```

`LastRunSummary` renders those numbers inside one `<span>` alongside other text, so if `getByText` cannot match across the element boundary, assert with a function matcher on the container's `textContent` instead of splitting the component up.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/admin-step7.test.tsx`
Expected: FAIL — no label matching `/simplifications per scrape run/i`.

- [ ] **Step 3: Extend the settings types**

In `web/src/pages/admin/settings/types.ts`:

```ts
export interface AppSettings {
  defaultAge: number;
  scrapeTimes: string[];
  llmProvider: string | null;
  apiKeyLocation: string;
  /** How many stored articles one scrape run may simplify. 0 disables it. */
  simplifyBudget: number;
}
```

```ts
export interface ScrapeRun {
  /* ...existing fields... */
  inserted: number;
  /** Of what the run stored, how many were simplified. */
  simplified: number;
  /** This source's raws still waiting when the run finished. */
  leftWaiting: number;
  /* ...rest unchanged... */
}
```

```ts
export interface ScrapeStatus {
  running: boolean;
  run: {
    id: string;
    startedAt: string;
    finishedAt?: string;
    sourceIds: string[];
    currentSourceId?: string;
    /** Which half of the run is happening. */
    phase: 'fetching' | 'simplifying';
    budget: number;
    simplifiedCount: number;
    results: {
      sourceId: string; sourceName: string; ok: boolean; error?: string;
      inserted: number; leftWaiting: number;
      simplified: { rawId: string; kidHeadline: string; safety: string; engine: string }[];
    }[];
    summary: { inserted: number; simplified: number; leftWaiting: number; failed: number; costUsd: number };
  } | null;
  lastRuns: Record<string, ScrapeRun>;
}
```

- [ ] **Step 4: Add the budget input**

In `web/src/pages/admin/settings/AppSettingsSection.tsx`, directly after the "Default reading age" label block:

```tsx
      <label className="mt-5 block max-w-xs">
        <span className="text-sm font-bold">Simplifications per scrape run</span>
        <TextInput
          type="number" min={0} max={100} value={draft.simplifyBudget}
          onChange={(e) => setDraft({ ...draft, simplifyBudget: Number(e.target.value) })}
        />
      </label>
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
        How many stored stories a run may send to the model. The rest are kept as they
        came in, costing nothing, and wait in the review queue's “Not yet simplified”
        tab until you ask for them. 0 means simplify nothing automatically.
      </p>
```

`TextInput` is already imported in this file — do not add a duplicate import.

- [ ] **Step 5: Show the counts in the run summary**

In `web/src/pages/admin/settings/ScrapeControls.tsx`, in `LastRunSummary`'s success return:

```tsx
  return (
    <span>
      {when} · <strong>{run.inserted}</strong> new
      {run.simplified > 0 && <>, <strong>{run.simplified}</strong> simplified</>}
      {run.leftWaiting > 0 && `, ${run.leftWaiting} still raw`}
      {run.skippedNotNew > 0 && `, ${run.skippedNotNew} already seen`}
      {run.skippedAlreadyStored > 0 && `, ${run.skippedAlreadyStored} duplicate`}
      {run.skippedUnusable > 0 && `, ${run.skippedUnusable} unusable`}
      {run.costUsd > 0 && ` · $${run.costUsd.toFixed(5)}`}
      {run.trigger === 'scheduled' && ' · scheduled'}
      {run.fallbacks.length > 0 && (
        <span className="text-amber-700"> · {run.fallbacks.length} fell back to the local pipeline</span>
      )}
    </span>
  );
```

In `ScrapeAllControls`, replace the in-progress line so it names the phase, and the finished notice so it reports the split:

```tsx
      {running && run && (
        <p className="mt-3 text-sm" role="status">
          {run.phase === 'simplifying' ? (
            <>Simplifying {run.simplifiedCount} of up to {run.budget}. Everything found is
            already stored — this is just the model pass.</>
          ) : (
            <>Fetching {run.currentSourceId ?? '…'} ({run.results.length} of {run.sourceIds.length} done).</>
          )}
        </p>
      )}

      {!running && run?.finishedAt && (
        <div className="mt-3">
          <Notice tone={run.summary.failed > 0 ? 'warn' : 'neutral'}>
            Finished: {run.summary.inserted} new article(s) across {run.sourceIds.length} source(s),
            {' '}{run.summary.simplified} simplified
            {run.summary.leftWaiting > 0 && `, ${run.summary.leftWaiting} left raw`}
            {run.summary.failed > 0 && `, ${run.summary.failed} source(s) failed`}
            {run.summary.costUsd > 0 && ` · $${run.summary.costUsd.toFixed(5)}`}
            . Simplified articles are waiting in the review queue
            {run.summary.leftWaiting > 0 && '; the rest are under “Not yet simplified”'}.
          </Notice>
        </div>
      )}
```

Also update the "Scraping" blurb so the button no longer implies it simplifies everything:

```tsx
          <p className="text-sm text-muted-foreground">
            Fetch every enabled source now, instead of waiting for the scheduled time.
            Everything found is stored; only the first few are simplified.
          </p>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS. Other settings tests may need `simplifyBudget: 10`, `simplified: 0` and `leftWaiting: 0` added to their `/app-settings` and `lastRuns` mocks — add the fields to the mocks; do not weaken the components to tolerate missing ones.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/admin/settings/ web/src/__tests__/admin-step7.test.tsx
git commit -m "feat(admin): tune the simplification budget and show what a run spent"
```

---

## Task 12: Documentation

**Files:**
- Modify: `README.md` (lines ~73, ~101-103, ~151, ~244-252, ~309-312)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update the pipeline diagram**

The diagram under `## How a story reaches a reader` currently reads:

```
BBC RSS feed ─┐
              ├─→ raw_articles ─→ guard + simplify ─→ kid_articles
paste by hand ┘                                        (pending_review)
                                                            │
                                              an editor approves it
                                                            ↓
                                                       published → the site
```

Replace it with the two-phase shape:

```
BBC RSS feed ─┐                  first 10 per run
              ├─→ raw_articles ─┬─→ guard + simplify ─→ kid_articles
paste by hand ┘                 │                        (pending_review)
                                │                             │
                                │                 an editor approves it
                                │                             ↓
                                │                        published → the site
                                └─→ the rest wait, unsimplified and free,
                                    under "Not yet simplified" in /admin/review
```

- [ ] **Step 2: Add a section explaining the budget**

Add after the scraping section (around line 113, next to the scheduled-run paragraph):

```markdown
### The simplification budget

A run stores **every** new article it finds, but simplifies only the first
`app_settings.simplifyBudget` of them (default **10**, editable in
`/admin/settings`). Four enabled feeds offer 40–50 new stories a day and an
editor triages maybe ten, so simplifying all of them spent roughly four times
what it needed to.

The budget is spread round-robin across sources, newest story first, so one busy
feed cannot take the whole allowance. A source with fewer new stories than its
share hands the remainder back, so a budget of 10 spends 10 whenever 10 stories
are waiting.

Everything else sits in `raw_articles` with `simplifiedAt = NULL`, costing
nothing. It is listed under **Not yet simplified** in `/admin/review`, where an
editor can simplify one row or a selection on demand; the next scheduled run
also works through the backlog before it runs out of budget.

Set the budget to `0` to simplify nothing automatically and do it all by hand.

This diverges from PRD §5.2, which runs steps 4–7 as a single pass over every
item. Steps 1–5 live in `ingestion/rssScraper.ts`; steps 6–7 moved to
`services/simplifyService.ts`.
```

- [ ] **Step 3: Fix the CLI, cost and table sections**

Line ~101-103, add the new flag to the command list:

```
npm run scrape -- --budget 3  # simplify at most 3 this run
```

The cost paragraph currently reads:

> Roughly **$0.0002 per article** on the default model, so a full 35-item scrape
> costs well under a penny. Several guards keep it that way, all in `.env`:

Replace those two sentences, because a run's cost is now the budget rather than the feed size:

```markdown
Roughly **$0.0002 per article** on the default model. A run costs the
simplification budget, not the size of the feed, so the default of 10 is about
$0.002 a day however much the feeds publish. Several guards keep it that way —
the budget in `/admin/settings`, and these in `.env`:
```

In the tables list, replace three rows (keep the column alignment of the surrounding table):

```markdown
| `raw_articles`                      | Original articles as fetched; `simplifiedAt` NULL means still waiting     |
| `app_settings`                      | Default reading age, scrape times, simplification budget, LLM provider    |
| `scrape_runs`                       | What each scrape stored, simplified and left raw                          |
```

In the `server/src` structure listing, replace the `services/` line:

```markdown
  services/           use cases: submit, regenerate, sandbox, scrape runs,
                      simplification (simplifyService, simplifyBudget, jobLock)
```

- [ ] **Step 4: Verify the claims**

Run: `cd server && npm test && npm run typecheck && cd ../web && npm test && npm run typecheck`
Expected: PASS everywhere. Then re-read the new README section against `simplifyBudget.ts` and `scrapeService.ts` and confirm every number and file path in it is real.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: explain the per-run simplification budget"
```

---

## Done-when

- A scrape of a 40-item feed leaves 40 `raw_articles` rows, 10 `kid_articles` rows and 30 rows with `simplifiedAt IS NULL`.
- The cursor has advanced past all 40, so a second run inserts nothing and spends its budget on the backlog instead.
- `/admin/review` shows a **Not yet simplified** tab with 30 rows, a working per-row and bulk Simplify, and live progress.
- `/admin/settings` can change the budget, and the last-run line reports what was simplified and what was left raw.
- A scrape and a manual batch cannot run at once; either failing releases the lock.
- Nothing anywhere publishes automatically.
- `cd server && npm test && npm run typecheck` and `cd web && npm test && npm run typecheck` all pass.
