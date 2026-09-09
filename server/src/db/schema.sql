-- =============================================================================
-- News4Littles — database schema
-- Source of truth: PRD v2.0 §8 (Data Models), plus §5.1 for Source.
-- Engine: SQLite via better-sqlite3, raw SQL, no ORM (§10).
--
-- CONVENTIONS
--   * Table names are snake_case. COLUMN NAMES ARE VERBATIM from the PRD's
--     TypeScript interfaces (kidHeadline, lastFetchedItemPublishedAt, ...) so
--     rows map onto the API/frontend contract with no renaming layer.
--   * SQLite has no BOOLEAN type -> stored as INTEGER 0/1 + CHECK (x IN (0,1)).
--   * SQLite has no ARRAY or OBJECT type -> those fields are TEXT holding JSON.
--     Every such column is tagged "JSON:" with the TypeScript shape it must
--     round-trip to, and guarded by a json_valid() CHECK. The application layer
--     owns JSON.parse on read and JSON.stringify on write.
--   * SQLite has no DATE type -> all timestamps are TEXT ISO-8601, matching the
--     PRD interfaces which already declare them as `string`.
--   * TypeScript optional (`field?`) -> nullable column.
--     TypeScript required          -> NOT NULL.
--   * TypeScript string unions -> TEXT + CHECK (... IN (...)).
--
-- This file is idempotent (every statement is IF NOT EXISTS), so re-running
-- `npm run db:init` against an existing database is a no-op.
-- It contains NO SEED DATA by design.
-- =============================================================================

PRAGMA foreign_keys = ON;


-- -----------------------------------------------------------------------------
-- sources — PRD §5.1
-- The feed list managed in /admin/settings, and the parent of every raw article.
--
-- ASSUMPTION (confirmed): manual editor submissions (§4.3) point at a real row
-- with id 'manual' rather than at a dangling string. This lets the review
-- queue's source dropdown (§4.2, "incl. manual") simply list this table, and
-- lets raw_articles.sourceId be a genuinely enforced foreign key.
-- That row is SEED DATA and is deliberately not inserted here. It will need
-- url = '' since a manual source has no feed.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id                         TEXT    PRIMARY KEY,               -- unique slug, e.g. 'bbc', 'manual'
  name                       TEXT    NOT NULL,                  -- display name, e.g. 'BBC News'
  url                        TEXT    NOT NULL,                  -- RSS/Atom/JSON feed URL or API endpoint ('' for 'manual')
  enabled                    INTEGER NOT NULL DEFAULT 1
                                     CHECK (enabled IN (0, 1)), -- boolean
  trustLevel                 TEXT    NOT NULL
                                     CHECK (trustLevel IN ('high', 'medium', 'low')),
  parser                     TEXT,                              -- optional; e.g. 'rss', 'bbc', 'ap-news'
  lastFetchedAt              TEXT,                              -- ISO; NULL until the first fetch
  lastFetchedItemPublishedAt TEXT,                              -- ISO; incremental-scrape cursor (§5.2 step 3)
  createdAt                  TEXT    NOT NULL,                  -- ISO
  updatedAt                  TEXT    NOT NULL                   -- ISO
);

CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources (enabled);


-- -----------------------------------------------------------------------------
-- raw_articles — PRD §8.2 (fetched from source, pre-simplification)
--
-- sourceId FK: ON DELETE RESTRICT so removing a source cannot orphan its
-- articles. Editors should disable a source (enabled = 0) rather than delete it
-- while its articles are still in the queue.
--
-- No UNIQUE constraint on url: §5.2 dedupes by publish time
-- (pubDate <= lastFetchedItemPublishedAt), not by URL. A unique index would
-- make the scraper throw on a duplicate instead of skipping it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_articles (
  id          TEXT PRIMARY KEY,
  sourceId    TEXT NOT NULL
              REFERENCES sources (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  sourceName  TEXT NOT NULL,                                    -- denormalised display name at fetch time
  sourceUrl   TEXT NOT NULL,                                    -- the source's site/feed URL
  url         TEXT NOT NULL,                                    -- canonical URL of this article
  headline    TEXT NOT NULL,                                    -- original (adult) headline
  body        TEXT NOT NULL,                                    -- original article text
  topic       TEXT NOT NULL,                                    -- maps to KidArticle.category
  publishedAt TEXT,                                             -- ISO; optional (feeds may omit pubDate)
  fetchedAt   TEXT NOT NULL,                                    -- ISO
  -- ISO when a kid article was created from this raw; NULL while it waits.
  -- A scrape run stores every item but simplifies only
  -- app_settings.simplifyBudget of them (a deliberate divergence from §5.2,
  -- which runs steps 4-7 as one pass). NULL therefore means "stored, never
  -- sent to the model".
  -- Deliberately NOT derived from "has no kid_articles row": §4.2 Delete
  -- removes the kid row and leaves this one, and a deleted article must not
  -- reappear in the backlog asking to be paid for again.
  simplifiedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_raw_articles_sourceId  ON raw_articles (sourceId);
-- Newest-first listing for the sandbox test-article dropdown (§7.6 /api/admin/raw-articles).
CREATE INDEX IF NOT EXISTS idx_raw_articles_fetchedAt ON raw_articles (fetchedAt DESC);
CREATE INDEX IF NOT EXISTS idx_raw_articles_url       ON raw_articles (url);
-- The backlog query only ever wants the NULLs, so the index only holds them.
CREATE INDEX IF NOT EXISTS idx_raw_articles_waiting
  ON raw_articles (sourceId, publishedAt DESC) WHERE simplifiedAt IS NULL;


-- -----------------------------------------------------------------------------
-- kid_articles — PRD §8.3 (simplified / published)
--
-- originalId FK: ON DELETE RESTRICT. Deleting a raw article must never silently
-- remove a published kid story (§2.2: everything passes through human review).
-- The Delete action in §4.2 operates on this table, not on raw_articles.
--
-- No UNIQUE (originalId, ageTarget): one raw article may yield several age
-- versions, per the per-age prompt overrides in §9 and the age filter in §4.2.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kid_articles (
  id              TEXT    PRIMARY KEY,
  originalId      TEXT    NOT NULL
                  REFERENCES raw_articles (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ageTarget       INTEGER NOT NULL CHECK (ageTarget BETWEEN 5 AND 14),   -- §3.6 slider range
  kidHeadline     TEXT    NOT NULL,
  summary         TEXT    NOT NULL,                                      -- 1-sentence card summary (§3.3)
  whatHappened    TEXT    NOT NULL,                                      -- story detail section (§3.4)
  whyItMatters    TEXT    NOT NULL,                                      -- story detail section (§3.4)
  vocab           TEXT    NOT NULL DEFAULT '[]',                         -- JSON: { word: string; definition: string }[]
  thinkAbout      TEXT    NOT NULL,                                      -- discussion prompt (§3.4)
  feelingNote     TEXT,                                                  -- optional; shown only when safety <> 'calm' (§3.4)
  safety          TEXT    NOT NULL
                  CHECK (safety IN ('calm', 'adult-nearby', 'skip-young')),
  contentWarnings TEXT,                                                  -- JSON: string[] | NULL (optional in §8.3)
  category        TEXT    NOT NULL,                                      -- e.g. Environment, Science, World, Sports, Good News
  readingMinutes  INTEGER NOT NULL CHECK (readingMinutes > 0),
  sourceName      TEXT    NOT NULL,
  sourceUrl       TEXT    NOT NULL,                                      -- "Read the original (for grown-ups)" link
  status          TEXT    NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review', 'published', 'rejected')),
  rejectReason    TEXT,                                                  -- optional free text (§4.2 Reject)
  editedByHuman   INTEGER NOT NULL DEFAULT 0
                  CHECK (editedByHuman IN (0, 1)),                       -- boolean; set by the §4.2 Edit action
  createdAt       TEXT    NOT NULL,                                      -- ISO
  publishedAt     TEXT,                                                  -- ISO; set when status becomes 'published'

  -- JSON columns must actually hold JSON.
  CHECK (json_valid(vocab)),
  CHECK (contentWarnings IS NULL OR json_valid(contentWarnings)),
  -- §4.2: "Approve (Publish) — status -> published, sets publishedAt".
  CHECK (status <> 'published' OR publishedAt IS NOT NULL)
);

-- Indexes back the review-queue tabs, filters and sorts in §4.2.
CREATE INDEX IF NOT EXISTS idx_kid_articles_status         ON kid_articles (status);
CREATE INDEX IF NOT EXISTS idx_kid_articles_status_created ON kid_articles (status, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_kid_articles_category       ON kid_articles (category);
CREATE INDEX IF NOT EXISTS idx_kid_articles_safety         ON kid_articles (safety);
CREATE INDEX IF NOT EXISTS idx_kid_articles_ageTarget      ON kid_articles (ageTarget);
CREATE INDEX IF NOT EXISTS idx_kid_articles_publishedAt    ON kid_articles (publishedAt DESC);
CREATE INDEX IF NOT EXISTS idx_kid_articles_originalId     ON kid_articles (originalId);
-- Free-text search (§4.2) is LIKE-based for now; FTS5 is a later, drop-in upgrade.


-- -----------------------------------------------------------------------------
-- guard_config — PRD §8.4
-- Singleton: the interface pins `id: 'default'`, and the CHECK enforces it so a
-- second config row cannot exist.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guard_config (
  id                 TEXT    PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  denyListEnabled    INTEGER NOT NULL DEFAULT 1
                     CHECK (denyListEnabled IN (0, 1)),         -- boolean
  denyList           TEXT    NOT NULL DEFAULT '[]',             -- JSON: string[] (editor-managed keywords, §6.1)
  promptGuardEnabled INTEGER NOT NULL DEFAULT 0
                     CHECK (promptGuardEnabled IN (0, 1)),      -- boolean; off until an LLM key exists (§13.2)
  promptGuardText    TEXT    NOT NULL DEFAULT '',               -- the LLM classifier prompt (§6.2)
  updatedAt          TEXT    NOT NULL,                          -- ISO

  CHECK (json_valid(denyList))
);


-- -----------------------------------------------------------------------------
-- translation_prompt_config — PRD §8.5
-- Singleton, same pattern as guard_config.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS translation_prompt_config (
  id            TEXT PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  genericPrompt TEXT NOT NULL DEFAULT '',                       -- fallback prompt when no age override exists (§9.1)
  ageOverrides  TEXT NOT NULL DEFAULT '{}',                     -- JSON: Record<string, string>  (age -> prompt)
  versions      TEXT NOT NULL DEFAULT '{}',                     -- JSON: Record<string, number>  (target+age -> version counter)
  updatedAt     TEXT NOT NULL,                                  -- ISO

  CHECK (json_valid(ageOverrides)),
  CHECK (json_valid(versions))
);


-- -----------------------------------------------------------------------------
-- prompt_drafts — PRD §8.6
-- The interface declares no id. The natural key is (target, age), and §7.4 says
-- "Drafts are listed per prompt target with age".
--
-- ASSUMPTION: `age` is optional (NULL for the generic simplification prompt and
-- for the guard prompt), and SQLite treats every NULL as distinct in a UNIQUE
-- constraint — so a plain UNIQUE (target, age) would allow unlimited duplicate
-- generic drafts. The expression index below collapses NULL to -1, giving true
-- one-draft-per-(target, age) semantics without inventing an id column.
-- Upsert with: ON CONFLICT (target, COALESCE(age, -1)) DO UPDATE ...
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_drafts (
  target     TEXT    NOT NULL CHECK (target IN ('simplification', 'guard')),
  age        INTEGER          CHECK (age IS NULL OR age BETWEEN 5 AND 14),  -- optional; age-bucket override
  promptText TEXT    NOT NULL,
  updatedAt  TEXT    NOT NULL,                                              -- ISO

  -- The guard prompt is not age-scoped (§7.3: age target applies to simplification only).
  CHECK (target <> 'guard' OR age IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_drafts_target_age
  ON prompt_drafts (target, COALESCE(age, -1));


-- -----------------------------------------------------------------------------
-- prompt_versions — PRD §7.5 (immutable record, one per promotion)
-- "version: monotonically increasing per target+age" — enforced by the unique
-- index below, using the same NULL-collapsing trick as prompt_drafts.
-- Rows here are append-only: never UPDATE or DELETE them.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_versions (
  id          TEXT    PRIMARY KEY,
  target      TEXT    NOT NULL CHECK (target IN ('simplification', 'guard')),
  age         INTEGER          CHECK (age IS NULL OR age BETWEEN 5 AND 14),  -- optional; for age-bucket overrides
  promptText  TEXT    NOT NULL,
  version     INTEGER NOT NULL CHECK (version > 0),
  promotedBy  TEXT    NOT NULL,                                             -- admin_users.username at promotion time
  promotedAt  TEXT    NOT NULL,                                             -- ISO
  note        TEXT,                                                         -- optional editor note

  CHECK (target <> 'guard' OR age IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_target_age_version
  ON prompt_versions (target, COALESCE(age, -1), version);
-- Version history listing (§7.6 GET /api/admin/prompts/versions), newest first.
CREATE INDEX IF NOT EXISTS idx_prompt_versions_promotedAt
  ON prompt_versions (promotedAt DESC);


-- -----------------------------------------------------------------------------
-- app_settings — PRD §8.7
--
-- ASSUMPTION: §8.7 declares no id, but this is a singleton like guard_config
-- and translation_prompt_config. The pinned id column is the one field here not
-- present in the PRD interface; it exists purely so a second row is impossible.
-- Strip it before serialising to the API to keep the AppSettings shape exact.
--
-- No API key column: §13.2 requires keys to live in environment variables only.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  id          TEXT    PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  defaultAge  INTEGER NOT NULL DEFAULT 6
              CHECK (defaultAge BETWEEN 5 AND 14),              -- §3.6: slider 5-14, default 6
  scrapeTimes TEXT    NOT NULL DEFAULT '["06:00"]',             -- JSON: string[] e.g. ["06:00"] (§5.3)
  llmProvider TEXT,                                             -- optional; 'openai' | 'anthropic' | NULL
  -- How many stored articles one scrape run may simplify (§5.2 divergence).
  -- 0 is legitimate: simplify nothing automatically. The ceiling is there so a
  -- typo in the settings form cannot cost a fortune.
  simplifyBudget INTEGER NOT NULL DEFAULT 10
                 CHECK (simplifyBudget BETWEEN 0 AND 100),

  CHECK (json_valid(scrapeTimes))
);


-- -----------------------------------------------------------------------------
-- scrape_runs — PRD §4.4 "Run now buttons ... with last-run results".
--
-- The sources table already records WHEN a fetch happened; this records what it
-- did. Kept as history rather than one column per source, so a run that failed
-- is still visible after the next one succeeds.
--
-- ON DELETE CASCADE, unlike raw_articles: run history is a log, and should
-- never be the reason a source cannot be removed.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_runs (
  id                   TEXT    PRIMARY KEY,
  sourceId             TEXT    NOT NULL
                       REFERENCES sources (id) ON UPDATE CASCADE ON DELETE CASCADE,
  startedAt            TEXT    NOT NULL,                          -- ISO
  finishedAt           TEXT    NOT NULL,                          -- ISO
  ok                   INTEGER NOT NULL CHECK (ok IN (0, 1)),     -- boolean
  error                TEXT,                                      -- set when ok = 0
  itemsInFeed          INTEGER NOT NULL DEFAULT 0,
  inserted             INTEGER NOT NULL DEFAULT 0,             -- raw articles stored
  simplified           INTEGER NOT NULL DEFAULT 0,             -- of those, how many were simplified
  versions             INTEGER NOT NULL DEFAULT 0,             -- age versions written across those stories
  leftWaiting          INTEGER NOT NULL DEFAULT 0,             -- this source's raws still waiting after the run
  skippedNotNew        INTEGER NOT NULL DEFAULT 0,
  skippedAlreadyStored INTEGER NOT NULL DEFAULT 0,
  skippedUnusable      INTEGER NOT NULL DEFAULT 0,
  costUsd              REAL    NOT NULL DEFAULT 0,                -- USD spent on the LLM
  fallbacks            TEXT    NOT NULL DEFAULT '[]',             -- JSON: string[] (§9.1 step 4)
  trigger              TEXT    NOT NULL
                       CHECK (trigger IN ('manual', 'scheduled')),

  CHECK (json_valid(fallbacks))
);

-- "the last run for this source", the query the settings page makes.
CREATE INDEX IF NOT EXISTS idx_scrape_runs_source_finished
  ON scrape_runs (sourceId, finishedAt DESC);


-- -----------------------------------------------------------------------------
-- admin_users — PRD §8.7
-- Single shared admin account is fine for v1 (§2.2 non-goals: no RBAC).
-- passwordHash is a bcrypt hash; a plaintext password must never be stored.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  username     TEXT PRIMARY KEY,
  passwordHash TEXT NOT NULL
);
