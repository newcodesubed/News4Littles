# News4Littles

A daily kid-friendly news aggregator. It pulls stories from trusted news feeds,
filters and rewrites them for children, and presents them in a calm, readable
interface. Every story is read by a human editor before a child sees it — nothing
publishes automatically, unless auto mode is switched on (see below).

- `/server` — Node.js + Express + SQLite (better-sqlite3), raw SQL, no ORM
- `/web` — React 18 + Vite + TypeScript + Tailwind

---

## Getting started

Requires **Node 20+**. Two terminals.

```bash
# terminal 1 — the API
cd server
npm install
cp .env.example .env
npm run db:init      # create the database
npm run db:seed      # sources, guardrails, prompts, admin account
npm run seed         # 8 sample articles, so the site is not empty
npm run dev          # http://localhost:4000

# terminal 2 — the site
cd web
npm install
cp .env.example .env
npm run dev          # http://localhost:5173
```

Open <http://localhost:5173>. For the editor side, go to
<http://localhost:5173/admin/review> and sign in with **`admin` / `admin123`**
(change it — see [Admin account](#admin-account)).

No API key is needed. Without one the app runs a local rule-based simplifier,
and everything works end to end — just with plainer output. See
[Turning on the LLM](#turning-on-the-llm).

---

## The pages

### Readers

| Route        | What it is                                                                              |
| ------------ | --------------------------------------------------------------------------------------- |
| `/`          | Today's stories                                                                         |
| `/story/:id` | One story: what happened, why it matters, words to know, a feeling note                 |
| `/podcast`   | Daily episode. The player is a **placeholder** — real audio is out of scope (§14)       |
| `/about`     | The mission and the editorial guardrails                                                |
| `/settings`  | Reading age and which sources to show. Saved in the browser only; there are no accounts |

### Editors

Everything under `/admin` needs the admin password.

| Route             | What it is                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| `/admin/review`   | The review queue — one row per story, every reading age approved together |
| `/admin/submit`   | Paste an article by hand and simplify it                                 |
| `/admin/settings` | Sources, guardrails, prompts, app defaults, and **Run now** scraping     |
| `/admin/sandbox`  | Edit a prompt and see what it does to a real article before promoting it |

---

## How a story reaches a reader

```
BBC RSS feed ─┐                  first 10 per run
              ├─→ raw_articles ─┬─→ guard + simplify ─→ kid_articles
paste by hand ┘                 │   (once per age, 5-14)  (10 versions,
                                │                          pending_review)
                                │                             │
                                │                 an editor approves it
                                │                             ↓
                                │                        published → the site
                                │                          (at the reader's age)
                                └─→ the rest wait, unsimplified and free,
                                    under "Not yet simplified" in /admin/review
```

Two things never change:

- **Nothing auto-publishes** by default. Scraped and pasted articles both land as
  `pending_review` (§5.2).
- **The safety guard has the final word.** Every article is classified `calm`,
  `adult-nearby` or `skip-young`. A keyword deny-list and the LLM both get a
  vote, and the strictest verdict wins (§6) — so a model calling a war story
  "calm" cannot publish it as calm.

A `feelingNote` is shown only when safety is not `calm`. That is a safety rule,
not styling, and it is gated on the safety level rather than on the field being
present.

---

## Scraping

```bash
cd server
npm run try:rss              # just prove the feed fetch works
npm run scrape               # every enabled source
npm run scrape:bbc           # one source
npm run scrape -- --limit 5  # cap items fetched (see the warning below)
npm run scrape -- --budget 3 # simplify at most 3 this run
```

Or click **Run all enabled** / **Run now** in `/admin/settings`, which shows
progress and what the last run did.

Fetching is incremental: items older than the newest one already stored are
skipped, and an item whose URL is already stored is skipped too. Only one run
happens at a time.

A scheduled run fires daily at the times in `app_settings.scrapeTimes`
(`["06:00"]` by default), editable in admin settings. **Changing the times needs
a server restart** — the cron jobs are registered at boot.

> **`--limit` is a testing aid, not a shortcut.** The feed is not sorted by date,
> so capping a run advances the incremental cursor past items it never stored.
> Those stories are then skipped forever. Use the plain command for real work.
> `--budget` is the safe one: it stores everything and only defers the
> simplifying.

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

Deleting a kid article leaves `simplifiedAt` set, so a story an editor has
rejected and deleted does not reappear in the backlog asking to be paid for
again.

This diverges from PRD §5.2, which runs steps 4–7 as a single pass over every
item. Steps 1–5 live in `ingestion/rssScraper.ts`; steps 6–7 moved to
`services/simplifyService.ts`.

### Auto mode (off by default)

Set `AUTO_APPROVE_ENABLED=true` and an LLM judges each story a scrape just
simplified, publishing the ones it approves with **no editor involved**. It
defaults to `false`, unlike every other flag here, because it trades away the
human review this product otherwise promises. It also needs a working LLM: no
API key means no judge, and no judge means nothing is auto-published.

The judge reads the **age-5 version** — the strictest reading level and the most
sensitive reader — and since publishing is story-scoped, one verdict covers all
ten ages. Its prompt lives in `pipeline/approvalGuard.ts` and is deliberately
not editable from admin settings: it is a safety gate, and one careless edit
would silently approve everything.

The story text is **fenced and treated as data**. The RSS feed is third-party and
the kid text is generated *from* it, so an instruction can reach the judge
without anyone typing it: feed → simplifier → judge. So the text sits inside
`<<<STORY>>>` markers, the rules come *after* it (the last thing the model reads
is the instruction, not the untrusted text), each field is capped at 1,000
characters, and a story whose own text reads as an instruction is **refused
before any call is made** — the model is never asked to resist something it does
not need to see.

That is defence in depth, not a guarantee. A judge can still be wrong about
ordinary content, only the age-5 version is judged, and the judge is the same
model that wrote the story. `approvedBy` is how you find its mistakes.

It fails **closed**. A story is published only on an explicit `approved: true`.
A timeout, an unreachable provider, HTML instead of JSON, a missing field, a
non-boolean field or a plain "no" all leave the story exactly as it was, in
`pending_review`, with the reason logged. There is no error path that can
publish something by accident.

Two things it will never touch:

- **`skip-young` stories.** Not judged at all, not even a call made. §6 makes
  those an explicit human decision, so the content most likely to upset a child
  stays human-only.
- **Anything already published or rejected.** A person's decision is never
  overwritten or relabelled as the judge's.

Every auto-publish sets `kid_articles.approvedBy = 'auto'`, and the review queue
marks those rows "published by the judge, not a person". That column is the
record of which live stories no human ever read — so if the judge turns out to
be a bad one, you can find them all and un-publish them.

### One version per reading age

A story is rewritten once for **every reading age from 5 to 14**, so the
reading-age slider on `/settings` selects real content rather than relabelling
a single version. Ten `kid_articles` rows share one `originalId`, one per
`ageTarget`.

Each age gets its own model call, using that age's prompt override if one
exists and the generic prompt with `{{age}}` substituted otherwise
(`selectPrompt`, §9.1). So a budget of 10 stories is **100 model calls**, about
$0.87 a month on the default model, and a run takes a few minutes rather than
seconds.

A combined single call would have cost about $0.47 a month, but every stored
prompt template embeds the article and its own JSON envelope — combining them
would mean sending the article ten times or mangling the templates. Forty cents
a month was not worth losing per-age prompt control or the sandbox's fidelity
to production (§7.4).

Failures are per age: if the age-7 call fails, age 7 falls back to the
rule-based pipeline (§9.2) and the other nine keep their model versions.

**The queue is grouped by story.** One row covers all ten versions, and its
safety badge shows the strictest verdict across them — a story that is
`skip-young` at age 5 never presents as `calm` because age 14 is. **View**
opens every version behind an age selector, because §2.2 promises a human read
every word a child sees and one Publish covers all ten.

Publish, reject, re-review and delete are **story-scoped**: they take any one
version's id and apply to every version of that story, so a story's versions
always share one status. The endpoint URLs are unchanged from when a story had
one version — `PATCH /api/admin/articles/:id/publish` now publishes the story
that id belongs to. **Edit is the exception** and stays per-version, so one
age's wording can be fixed without touching the other nine, and
`editedByHuman` stays a per-version flag.

Bulk approve still excludes `skip-young` unless you opt in, and that check uses
the story's strictest version — selecting a calm age-14 row cannot publish a
skip-young age-5 one.

Tab counts show stories, not versions, so Pending reads 10 where you have ten
stories to read rather than 100.

**The slider on `/settings` picks the text.** `GET /api/articles?age=N` returns
the version of each story that was **written for age N** — an exact match, no
nearest-age guessing. A story exists in one version per age, so a missing age
means it was never simplified for that reader, and it is simply absent from the
feed. Showing a five-year-old an age-12 rewrite is worse than showing nothing.
`GET /api/articles/:id?age=N` applies the same rule inside one story, so the
slider keeps working after a reader has opened something, and 404s for an age
the story does not have — consistent with the feed, which would not have
offered it.

An absent, non-numeric or out-of-range `age` falls back to
`app_settings.defaultAge` rather than erroring — this is the path a child's
browser hits, and answering beats a 400 because a query string was odd. The
status filter stays hardcoded regardless.

A story simplified before this feature has one version, at whatever the default
age was then, so it appears only at that age. Re-simplify it to give it all ten.

The §6 guards run **once per story** — they judge the source article, which does
not vary by age — so the prompt guard costs one call, not ten.

Without an API key the rule-based pipeline handles every age, using
`age * 2` words per sentence. That reproduces §9.2's three stated anchors
exactly (7 → 14, 10 → 20, 14 → 28) while giving every age its own limit, so the
slider still changes the text offline.

---

## Turning on the LLM

Without a key, articles go through the local rule-based simplifier (§9.2):
sentences truncated by age, a few filler words removed, vocabulary from a fixed
dictionary. Truthful, and quite plain.

With a key, an LLM rewrites the story properly (§9.1) and the difference is
large:

|          |                                                           |
| -------- | --------------------------------------------------------- |
| Original | Volkswagen board approves plan to cut another 50,000 jobs |
| Local    | Volkswagen board approves plan to cut another 50,000 jobs |
| LLM      | Car Company Plans Big Changes                             |

Put an [OpenRouter](https://openrouter.ai) key in `server/.env`:

```bash
OPENROUTER_KEY=sk-or-v1-...
```

Then check it:

```bash
cd server
npm run llm:check    # runs 3 real articles through both paths and reports the cost
```

Roughly **$0.0002 per article version** on the default model. A run costs the
budget times ten, because each story is rewritten for every reading age — so
the default of 10 stories is 100 calls, about $0.03 a day. Several guards keep
it that way — the budget in `/admin/settings`, and these in `.env`:

| Setting              | Default                        | Why                                                                     |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `LLM_ENABLED`        | `true`                         | Set to `false` to fall back to the free local path instantly            |
| `LLM_MODEL`          | `google/gemini-2.5-flash-lite` | Any OpenRouter model id                                                 |
| `LLM_MAX_BODY_CHARS` | `6000`                         | Article text is truncated first, so one huge paste cannot run up a bill |
| `LLM_MAX_TOKENS`     | `1500`                         | Caps the priced half of each response                                   |
| `LLM_MAX_RETRIES`    | `1`                            | Transient failures only (429, 5xx) — never a retry storm                |

If a call fails or the response cannot be parsed, the article falls back to the
local pipeline and the reason is recorded, so a dead API degrades rather than
breaks.

**The key belongs in `server/.env` and nowhere else** — never in the database,
never in seed data, never committed (§13.2). `.env` is gitignored.

---

## Prompts and the sandbox

Prompt wording is the highest-leverage thing in this project. Strengthening the
safety criteria in one prompt moved classification from 2/5 to 5/5 correct on a
fixed set of test articles — same model, same single call, same cost.

`/admin/sandbox` is the tool for that work:

- pick a prompt (generic, a per-age override, or the safety guard) and an article
- edit, then **Run test** — the output renders exactly as a reader would see it
- **Compare with production** shows both side by side with a field-level diff
- validation shows whether the response parsed and whether sentences fit the age
- **Save draft** never affects production; **Promote** does, and needs a
  successful test run first

Every promotion is recorded permanently with who, when and an optional note, and
any two versions can be diffed.

Nothing in the sandbox writes production article data.

The prompts that ship are written from the spec, not tuned. Replacing them is a
good first job, and the sandbox is where to do it.

```bash
npm run db:update-prompts   # carry improved seeded prompts to an existing database
                            # (leaves a prompt you have edited alone)
```

---

## Admin account

`admin` / `admin123` by default. The database stores only a bcrypt hash; the
plaintext lives in `server/.env`.

To change it:

```bash
cd server
# edit ADMIN_USERNAME / ADMIN_PASSWORD in .env, then
npm run db -- "SELECT username FROM admin_users"   # confirm what is there
node -e "require('better-sqlite3')('data/news4littles.db').prepare('DELETE FROM admin_users').run()"
npm run db:seed                                     # recreates it from .env
```

`db:seed` never overwrites an existing row, which is why the old one has to go
first.

---

## The database

One SQLite file at `server/data/news4littles.db` (gitignored). Schema in
[`server/src/db/schema.sql`](server/src/db/schema.sql), which is the source of
truth and heavily commented.

```bash
cd server
npm run db                        # every table with a row count
npm run db -- kid_articles 5      # dump a table
npm run db -- "SELECT ..."        # read-only SQL
```

Column names match the TypeScript interfaces in PRD §8 exactly
(`kidHeadline`, not `kid_title`), so rows map onto the API with no renaming
layer.

Every statement in `schema.sql` is `CREATE ... IF NOT EXISTS`, so `npm run
db:init` is safe to re-run and is how a schema addition reaches a database that
already has rows in it.

| Table                               | Holds                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| `sources`                           | Feeds to scrape, plus a `manual` row for hand submissions |
| `raw_articles`                      | Original articles as fetched; `simplifiedAt` NULL means still waiting |
| `kid_articles`                      | Rewritten stories, one row per reading age, and their review status |
| `guard_config`                      | Deny-list and the safety-guard prompt                     |
| `translation_prompt_config`         | Live simplification prompts                               |
| `prompt_drafts` / `prompt_versions` | Sandbox drafts and promotion history                      |
| `app_settings`                      | Default reading age, scrape times, simplification budget, LLM provider |
| `admin_users`                       | The single admin account (bcrypt)                         |
| `scrape_runs`                       | What each scrape stored, simplified, versioned and left raw |

Some constraints are load-bearing rather than decorative: a `published` row must
have a `publishedAt`; deleting a source with stored articles is refused (disable
it instead); and JSON columns are checked with `json_valid`.

---

## Tests

```bash
cd server && npm test    # 373 tests
cd web    && npm test    # 219 tests
```

Both suites are offline and free. Each server suite gets its own temporary
database and port, RSS tests serve a feed from a local HTTP server, and
`vitest.config.ts` hard-sets `LLM_ENABLED=false` so **no test can call a paid
API** — the LLM path is driven by a stub instead.

`npm run typecheck` in either package. Note that `tsconfig.json` currently
covers `src` only, so files under `server/scripts/` are not typechecked.

---

## Configuration

`server/.env` — see [`.env.example`](server/.env.example) for all of it.

|                   | Default                                        |
| ----------------- | ---------------------------------------------- |
| `PORT`            | `4000`                                         |
| `CORS_ORIGIN`     | `http://localhost:5173,http://127.0.0.1:5173`  |
| `DATABASE_PATH`   | `data/news4littles.db` (relative to `/server`) |
| `SCRAPE_ENABLED`  | `true` — `false` stops cron registering        |
| `AUTO_APPROVE_ENABLED` | **`false`** — `true` lets an LLM publish without an editor |
| `SCRAPE_TIMEZONE` | the server's own zone                          |

`web/.env`:

|                     | Default                 |
| ------------------- | ----------------------- |
| `VITE_API_BASE_URL` | `http://localhost:4000` |

Point the web app at a different host by changing `VITE_API_BASE_URL` **and**
adding that origin to the server's `CORS_ORIGIN`.

---

## Layout

```
server/src/
  app.ts              Express wiring (no listen, no scheduler — tests build this)
  server.ts           process bootstrap
  core/               domain types and errors — no express, no sqlite
  db/                 schema.sql, connection, seeds, repositories (all SQL lives here)
  http/               middleware and shared request validation
  pipeline/           the safety guard and rule-based simplification
  llm/                the OpenRouter client and response parsing
  ingestion/          RSS fetching, parsing, scheduling
  services/           use cases: submit, regenerate, sandbox, scrape runs,
                      simplification (simplifyService, simplifyBudget, jobLock)
  routes/             public/ and admin/

web/src/
  lib/                API client, shared types, hooks
  ui/                 Button, Field, Card, Chip, Notice
  components/         badges, story card, the shared StoryPreview
  pages/              reader pages
  pages/admin/        review/, submit, settings/, sandbox/, dialogs/
  admin/              auth context and the admin action hook
```

`StoryPreview` is shared by the public story page, the review queue's preview
and the sandbox, so all three render identically by construction rather than by
resemblance.

---

## Not built

- **Real podcast audio.** The `/podcast` player is a placeholder. Out of scope
  for v1 (§2.2, §14) and needs a TTS key.
- **Multiple admin accounts / roles.** One shared account by design (§2.2).
- **Translations, mobile apps.** Out of scope (§14).

One known ambiguity: PRD §11.1 says the public reading-age slider should drive
the default age for new simplifications, but §4.4 assigns that setting to admin
settings. Since `/settings` has no auth, the admin slider owns
`app_settings.defaultAge`; the public slider drives the badge and is
browser-local.
