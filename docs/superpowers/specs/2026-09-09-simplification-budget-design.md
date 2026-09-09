# Simplification budget — design

**Date:** 2026-09-09
**Status:** approved, ready for an implementation plan

## 1. Problem

`rssScraper.storeItems` simplifies every new feed item before writing anything:
it loops the candidates and `await`s `simplifyArticle` on each one. With BBC,
Reuters, AP and NPR enabled, one run is 40–50 LLM calls — doubled when §6.2's
prompt guard is on, since that bills a second call per article.

Every one of those articles lands in the review queue as `pending_review`. An
editor realistically triages the top handful and never reaches the rest, so the
run pays for ~40 simplifications to get ~10 used. The waste is the entire tail.

## 2. What this changes

Split what is now one pass into two:

- **Ingest** — cheap, unbounded. Fetch every enabled source and store every new
  item as a `raw_articles` row, advancing the incremental cursor exactly as now.
  Nothing is lost and nothing gets re-fetched.
- **Simplify** — expensive, capped, resumable. Spend a budget of N (default 10)
  LLM simplifications per run, spread round-robin across sources, newest first.
  Everything else stays raw at zero cost until an editor asks for it.

Deliberate divergence from the PRD: §5.2 lists steps 4–7 as a single pass over
every item. This splits 6–7 off behind a budget. The codebase cites PRD sections
in ~350 places, so the split point must be commented as a divergence rather than
left claiming compliance it no longer has.

### Decisions taken

| Question | Decision |
|---|---|
| Budget scope | N per **run**, spread round-robin across sources |
| Which items win | Newest by feed `publishedAt` |
| Manual trigger | A new tab in the review queue |
| Configurable | An `app_settings` column, editable on `/admin/settings` |
| Bulk simplify | Background job with polling, sharing the scrape lock |

## 3. Two gaps this design also has to close

Neither was in the original request; both block it.

**Unsimplified raws are invisible.** Nothing in the database records whether a
raw has been simplified, and `/admin/review` reads `kid_articles` only. A raw
with no kid row cannot be seen or acted on anywhere in the UI.

**A deleted article must not come back.** `articleActions.ts:96` `remove()`
deletes the `kid_articles` row and leaves the raw behind. If "unsimplified" were
defined as *no kid row exists*, every article an editor deletes would reappear
in the backlog forever, asking to be paid for again. The state must therefore be
an explicit marker, not an inferred one.

## 4. Data model

### 4.1 `raw_articles.simplifiedAt`

```sql
simplifiedAt TEXT   -- ISO; NULL means "never simplified" (waiting).
                    -- Stamped when a kid_articles row is created from this raw.
```

Semantics: *"we already spent money on this one"* — which is precisely the thing
being rationed, and is why it survives the kid row being deleted.

```sql
CREATE INDEX idx_raw_articles_waiting ON raw_articles (sourceId, publishedAt DESC)
  WHERE simplifiedAt IS NULL;
```

A partial index, because the backlog query only ever wants the NULLs.

Ordering: `ORDER BY publishedAt DESC` puts rows with a NULL `publishedAt` last
in SQLite (verified), which is the behaviour wanted — feeds may omit `pubDate`
(`feedParser.readPublishedAt`), and an undated item is the lowest-priority
candidate for a scarce budget, not the highest.

The two non-scrape insert sites stamp `simplifiedAt` immediately, so neither
ever appears as waiting:

- `submitArticle.ts:151` — an editor's manual submission (§4.3) arrives already
  simplified, raw and kid rows written in one transaction.
- `seed-articles.ts:333` — sample data.

### 4.2 `app_settings.simplifyBudget`

```sql
simplifyBudget INTEGER NOT NULL DEFAULT 10 CHECK (simplifyBudget BETWEEN 0 AND 100)
```

`0` is legitimate: simplify nothing on a scrape, do it all by hand. The upper
bound of 100 exists so a typo in the settings form cannot cost a fortune.

Threading: `AppSettings` interface, `getAppSettings`, `saveAppSettings` (all in
`settingsRepository.ts:121-140`), and `PUT /app-settings`
(`settings.ts:109`) validated with the existing
`requireInt(body.simplifyBudget, 'simplifyBudget', { min: 0, max: 100 })`.

### 4.3 `scrape_runs` counts

`LastRunSummary` renders the *persisted* last run per source
(`runs.latestPerSource()`), not the in-memory state, so the new counts have to
be stored:

```sql
simplified  INTEGER NOT NULL DEFAULT 0   -- of the inserted raws, how many were simplified
leftWaiting INTEGER NOT NULL DEFAULT 0   -- how many were left raw
```

Same `ALTER TABLE` treatment as the other two columns.

### 4.4 Migration

`initialiseSchema` (`db/init.ts`) runs only `CREATE ... IF NOT EXISTS`, so it
cannot add a column to an existing database. There is no migration runner today.

- Bump `SCHEMA_VERSION` 2 → 3, with the changelog comment the file already keeps.
- Add both columns to `schema.sql`'s `CREATE TABLE` statements, for fresh databases.
- After the schema exec, for each new column: read `PRAGMA table_info(<table>)`
  and `ALTER TABLE <table> ADD COLUMN ...` when absent. Idempotent, so
  `npm run db:init` stays safe to re-run.
- Backfill `UPDATE raw_articles SET simplifiedAt = fetchedAt WHERE simplifiedAt IS NULL`,
  correct by construction: under today's code every stored raw was simplified at
  the moment it was stored.

Verified against the pinned better-sqlite3 (SQLite 3.49.2): `ALTER TABLE ADD
COLUMN` accepts `INTEGER NOT NULL DEFAULT 10 CHECK (...)` and backfills existing
rows with the default, and `CREATE INDEX ... WHERE simplifiedAt IS NULL` is
accepted. No nullable-then-backfill workaround is needed.

## 5. Phase 1 — ingest (`ingestion/rssScraper.ts`)

`storeItems` loses its `simplifyArticle` call, and with it the "prepare
everything async, then write the batch in one sync transaction" dance its
current comment explains. It becomes a plain synchronous transaction that
inserts raws with `simplifiedAt: null` and advances the cursor as now.
`scrapeSource` stays `async` only because `fetchFeed` is. §5.2 steps 1–5 only.

`ScrapeResult` changes shape:

| field | change |
|---|---|
| `inserted` | unchanged meaning — raw articles stored |
| `stored[]` | now `{ rawId, headline, url, publishedAt }`; drops `kidHeadline`, `safety`, `engine`, which an unsimplified raw does not have |
| `simplified[]` | **new** — `{ rawId, kidHeadline, safety, engine }`, filled by phase 2 |
| `leftWaiting` | **new** — stored but not simplified |
| `costUsd`, `fallbacks` | unchanged fields, now populated by phase 2 |

**Two caps, kept distinct.** `ScrapeOptions.limit` is untouched and still caps
how many items are *fetched and stored*, discarding the rest (a testing aid;
see the warning in `scripts/scrape.ts`). `simplifyBudget` caps how many stored
items are *simplified*. Both comments must say which is which — two caps in one
module is exactly what gets conflated later.

## 6. Phase 2 — spend the budget (`services/simplifyService.ts`)

Two pieces, split so the allocation rule is testable with no database:

```ts
// Pure. Queues are per-source, each already newest-first.
export function selectBudgetedBatch(
  queues: { sourceId: string; rawIds: string[] }[],
  budget: number,
): string[]

// The engine. Phase 2 and the manual tab both call exactly this.
export async function simplifyRawArticles(
  db: Database, rawIds: string[], options?: { client?: OpenRouterClient },
): Promise<SimplifyOutcomeRow[]>
```

**Round-robin** takes one id from each source queue in turn, in the run's stable
source order, until the budget is spent or every queue is empty. Stable order
keeps tests deterministic. The rule self-corrects: a source with only one new
item takes its one and its unused share flows to the others, so a budget of 10
spends 10 whenever 10 candidates exist.

**Per-article transaction, not per-batch.** `simplifyArticle` is async, so it
cannot sit inside a `better-sqlite3` transaction regardless. Each article does
`await simplifyArticle(...)`, then one small synchronous transaction that
inserts the kid row (`status: 'pending_review'`, `publishedAt: null` — §5.2 step
7 unchanged) and stamps `simplifiedAt`. The batch is therefore **resumable**: a
crash on article 7 keeps 1–6 and leaves the rest waiting, ready to retry. That
property is what the marker column buys.

`ageTarget` comes from `app_settings.defaultAge`, as scraping does today. No
per-article age choice in the tab; that is what Regenerate is for.

`simplifyRawArticles` skips any id whose `simplifiedAt` is already set, so a
double-submit from two browser tabs cannot produce two kid articles for one raw.

Phase 2 attributes each outcome's cost and counts back to its source before
`scrapeRunRepository.record` writes the run rows. Consequence: run rows are now
written after phase 2 rather than immediately after each source is fetched. The
whole run is already background + polled, so nothing user-facing regresses.

## 7. Job lock (`services/jobLock.ts`)

One module-level `'scrape' | 'simplify' | null`. Both services acquire it and
release it in a `finally`; acquiring while held throws `ConflictError` naming
the holder.

Required for correctness, not tidiness: phase 2 and a manual batch operating on
the same raw rows concurrently is the double-insert this prevents. It also fixes
a live bug — the current scrape IIFE has no `finally`, so a throw inside it
leaves `running: true` forever, as its own comment at `scrapeService.ts:88`
admits. `resetRunState()` keeps working as a test seam and additionally releases
the lock, so existing tests are unaffected.

## 8. API

```
GET  /api/admin/raw-articles/waiting          the backlog; newest publishedAt first,
                                              undated last; ?source=, ?limit=
                                              (default 50, max 200)
POST /api/admin/raw-articles/simplify         { ids: string[] } -> 202 + job state
GET  /api/admin/raw-articles/simplify/status  { running, job } for polling
GET  /api/admin/articles/counts               gains a `waiting` key for the tab badge
```

New router `routes/admin/rawArticles.ts`, mounted in `ADMIN_ROUTERS`. Path
prefixes do not collide with `/articles/:id`, so ordering is unconstrained.

The existing `GET /raw-articles` (§7.6, the sandbox's test-article dropdown,
currently an outlier inside `prompts.ts:27`) moves into the new router. Same URL,
so the sandbox is unaffected.

`waiting` on the counts endpoint is composed in the route from
`articles.countsByStatus()` plus a new `rawArticleRepository.countWaiting()` —
composition is the route's job, and the raw count belongs on the raw repository.

## 9. Web UI

`AdminReview` gains a fourth tab, `{ key: 'waiting', label: 'Not yet simplified' }`.
It is not a `kid_articles.status`, so the page branches on it:

- Renders a new `review/WaitingList.tsx` (source · original headline · published ·
  body length · checkbox · **Simplify**) instead of `ArticleRow`.
- `FilterBar` shows only source and search. Safety, age and category do not
  exist on a raw article.
- `BulkBar` reads "Simplify N selected".

Single Simplify is synchronous, matching the existing Regenerate action
(~5–8s, one LLM call). Bulk posts the selected ids, then polls the status
endpoint every 2s showing "Simplifying 3 of 8…", and on completion reloads the
list and counts so finished stories visibly move to Pending review.

`settings/ScrapeControls.tsx` — `LastRunSummary` gains "· 10 simplified, 31 left
raw". `settings/AppSettingsSection.tsx` gains a number input for the budget,
which is what makes the feature visible and tunable.

## 10. Failure handling

- `simplifyArticle` never throws; it falls back to the rule-based pipeline (§9.2)
  and flags it. "Unsimplifiable" is therefore not a state, and the fallback
  behaviour is unchanged.
- A database failure on one article is caught per-article and recorded in the
  job's `failures[]`. `simplifiedAt` stays NULL, so the row remains waiting and
  retryable; the batch continues.
- One dead source in phase 1 still cannot stop the others: `scrapeSource` keeps
  returning `{ ok: false, error }` rather than throwing.
- A crash anywhere in either job releases the lock via `finally`.

## 11. Tests

TDD — each written before its implementation.

**New:**

- `server/tests/simplify-budget.test.ts` — the pure allocator: 4 sources × 20
  with budget 10 → 3/3/2/2 in stable order; a source with 1 candidate does not
  waste its share; budget 0; budget ≥ total; a single source.
- `server/tests/simplify-service.test.ts` — stamps `simplifiedAt` and inserts
  `pending_review`; skips already-simplified ids; keeps earlier successes when
  one fails; releases the lock on a crash; refuses to start while a scrape runs,
  and a scrape refuses while it runs.

**Extended:**

- `server/tests/ingestion.test.ts` — a 25-item feed with budget 10 stores 25
  raws, creates 10 kid articles, leaves 15 with `simplifiedAt IS NULL`, and
  advances the cursor past all 25. The suite's existing feeds are all smaller
  than 10 items, so the rest should pass unchanged; a break there is a real
  behaviour change and gets surfaced, not quietly edited.
- `server/tests/db.test.ts` — a v2 database migrates to v3, gains both columns,
  and backfills `simplifiedAt`.
- `server/tests/admin-queue.test.ts` — `/articles/counts` includes `waiting`;
  `/raw-articles/waiting` returns only unsimplified rows, newest first.
- `server/tests/scrape-run.test.ts` — recorded runs carry the new counts.
- `web/src/__tests__/admin-review.test.tsx` — the tab lists raw rows, Simplify
  posts the ids, progress renders, completion refreshes.
- `web/src/__tests__/admin-step7.test.tsx` — the budget input saves.

## 12. Out of scope

- Pruning or expiring the raw backlog. It costs nothing to keep; revisit if it
  grows unmanageable.
- Per-article age selection when simplifying manually. Regenerate covers it.
- Multi-instance safety. The job lock is module-level, matching the existing
  single-process, single-admin assumption (§2.2); it would have to move into the
  database if the app is ever run as more than one instance.
