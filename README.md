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
| `/podcast`   | Daily episode. Each story is really read aloud by a text-to-speech voice; the whole-episode player is still a **placeholder** (§14) |
| `/about`     | The mission and the editorial guardrails                                                |
| `/settings`  | Reading age and which sources to show. Saved in the browser only; there are no accounts |

### Editors

Everything under `/admin` needs the admin password.

| Route             | What it is                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| `/admin/review`   | The review queue — one row per story, every reading group approved together |
| `/admin/submit`   | Paste an article by hand and simplify it                                 |
| `/admin/settings` | Sources, guardrails, app defaults, and **Run now** scraping (prompts are edited in the sandbox) |
| `/admin/sandbox`  | Edit a prompt and see what it does to a real article before promoting it |

---

## How a story reaches a reader

```
BBC RSS feed ─┐                  first 10 per run
              ├─→ raw_articles ─┬─→ guard + simplify ─→ kid_articles
paste by hand ┘                 │   (once per reading     (3 versions + a spoken
                                │    group: 5-7, 8-10,     script, pending_review)
                                │    11-14)
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

An editor can also **Delete** a waiting row, or a selection. That sets
`dismissedAt` rather than removing the row: the row is what stops a later
scrape storing the same item again, so a deleted article stays out of the
backlog, the counts and the budget for good. This arrived in schema version 7,
so an existing database needs `npm run db:init` once; the server refuses to
start until it has run.

Set the budget to `0` to simplify nothing automatically and do it all by hand.

Deleting a kid article leaves `simplifiedAt` set, so a story an editor has
rejected and deleted does not reappear in the backlog asking to be paid for
again.

This diverges from PRD §5.2, which runs steps 4–7 as a single pass over every
item. Steps 1–5 live in `ingestion/rssScraper.ts`; steps 6–7 moved to
`services/simplifyService.ts`.

### Categories

The BBC front-page feed carries no category, so a story's category is decided
in two steps:

1. **At scrape time, a keyword guess** (`pipeline/categorize.ts`). Free, no API
   key needed, and it is the category the rule-based pipeline keeps. Anything
   that matches no keywords is `World`.
2. **When the model rewrites the story, the model picks** from the same list
   the site has badges for (`CATEGORIES` in `core/article.ts`, mirrored in
   `web/src/components/Badges.tsx`). The keyword guess is only the hint it sees
   as `{{category}}`. A pick that is not on the list is ignored, and the guess
   stands.

A story has **one category across its three versions**: the youngest group's
pick, or the next group's if that one fell back to the rule-based pipeline.
A story an editor pasted in `/admin/submit` keeps the category the editor
chose, including through Regenerate. Stories simplified before this change
stay `World` until an editor edits or regenerates them.

A custom prompt only gets model-picked categories if it asks for a
`"category"` field; the seeded prompts do, and `npm run db:init` brings an
untouched seeded prompt up to date.

### Auto mode (off by default)

Set `AUTO_APPROVE_ENABLED=true` and an LLM judges each story a scrape just
simplified, publishing the ones it approves with **no editor involved**. It
defaults to `false`, unlike every other flag here, because it trades away the
human review this product otherwise promises. It also needs a working LLM: no
API key means no judge, and no judge means nothing is auto-published.

The judge reads the **ages 5–7 version** — the strictest reading level and the
most sensitive reader — and since publishing is story-scoped, one verdict covers
every group. Its prompt lives in `pipeline/approvalGuard.ts` and is deliberately
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
ordinary content, only the youngest version is judged, and the judge is the same
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

### One version per reading group

A story is rewritten once for each of **three reading groups — ages 5–7, 8–10
and 11–14** — so the reading-age slider on `/settings` selects real content
rather than relabelling a single version. Three `kid_articles` rows share one
`originalId`, and each carries its group's **youngest age** as `ageTarget`
(5, 8 or 11). The groups are the same three bands §9.2 already uses for the
rule-based pipeline, and they live in one place: `AGE_BANDS` in
`server/src/core/article.ts` (mirrored for the UI in `web/src/lib/ageBands.ts`).

Each group gets its own model call, using that group's prompt override if one
exists and the generic prompt otherwise (`selectPrompt`, §9.1). The prompt sees
`{{age}}` (the group's youngest age — vocabulary is pitched at the youngest
reader, the safe direction) and `{{ageRange}}` (the whole group, "5 to 7", so
the model knows one text serves several ages). A budget of 10 stories is
**30 model calls** — a run takes about a minute.

This replaced one call per age (ten per story). A 6-year-old and a 7-year-old
do not need different rewrites, and the ten-version design cost three times the
calls, tokens and storage and gave editors ten near-identical texts to read
before approving one story. A combined single call was rejected both times, for
the same reason: every stored prompt template embeds the article and its own
JSON envelope, so combining them means sending the article once per group
anyway, or mangling the templates and losing per-group prompt control and the
sandbox's fidelity to production (§7.4).

Failures are per group: if the 8–10 call fails, that group falls back to the
rule-based pipeline (§9.2) and the other two keep their model versions.

**The queue is grouped by story.** One row covers all three versions, and its
safety badge shows the strictest verdict across them — a story that is
`skip-young` for ages 5–7 never presents as `calm` because 11–14 is. **View**
opens every version behind a reading-group selector, because §2.2 promises a
human read every word a child sees and one Publish covers all three.

Publish, reject, re-review, delete and regenerate are **story-scoped**: they
take any one version's id and apply to every version of that story, so a
story's versions always share one status. The endpoint URLs are unchanged from
when a story had one version — `PATCH /api/admin/articles/:id/publish` now
publishes the story that id belongs to. **Edit is the exception** and stays
per-version, so one group's wording can be fixed without touching the others,
and `editedByHuman` stays a per-version flag. An edit may move a version to a
different group, but only to a group — `ageTarget` must be 5, 8 or 11, because
the public read path matches it exactly and a row at age 6 would reach nobody.

**Regenerate previews every group and applies the ones you tick.** Three
versions is three sequential model calls, so
`POST /api/admin/articles/:id/regenerate` starts a background job and the row
polls `GET /api/admin/articles/regenerate/status` — the same shape as a scrape
or a manual simplify batch, and the same one-job-at-a-time lock. The dialog
shows a tab per group with its own diff; versions a person has edited arrive
unticked. `POST /api/admin/articles/regenerate/apply` writes the ticked groups
from the held preview, so applying costs no further model calls and writes
exactly the text that was on screen.

Bulk approve still excludes `skip-young` unless you opt in, and that check uses
the story's strictest version — selecting a calm 11–14 row cannot publish a
skip-young 5–7 one.

Tab counts show stories, not versions, so Pending reads 10 where you have ten
stories to read rather than 30.

**The slider on `/settings` picks the text.** `GET /api/articles?age=N` resolves
N to its reading group and returns the version of each story **written for that
group** — an exact match on the group, no nearest-group guessing. A story with
no version for the group was never simplified for that reader, and it is simply
absent from the feed. Showing a five-year-old the 11–14 rewrite is worse than
showing nothing. `GET /api/articles/:id?age=N` applies the same rule inside one
story, so the slider keeps working after a reader has opened something, and
404s for a group the story does not have — consistent with the feed, which
would not have offered it.

An absent, non-numeric or out-of-range `age` falls back to
`app_settings.defaultAge` rather than erroring — this is the path a child's
browser hits, and answering beats a 400 because a query string was odd. The
status filter stays hardcoded regardless. `defaultAge` is a reader's age, any
of 5–14; the pipeline resolves it to a group itself.

**Migrating an existing database.** Stories simplified before reading groups
hold one row per age (5–14), or a single row at whatever the default age was.
Rows at 6, 7, 9, 10, 12, 13 and 14 are unreachable now. Run

```bash
cd server
npm run db:migrate-age-bands            # dry run: prints what would change
npm run db:migrate-age-bands -- --apply # collapse each story onto 5 / 8 / 11
npm run db:init                         # adopt the group-aware seeded prompts
```

In every group a story has rows for, the migration keeps one — the row already
at the group's youngest age, else the youngest row, re-labelled — and deletes
the rest. It re-keys per-age prompt overrides and drafts the same way and
leaves the append-only prompt history alone. Until it is run, a legacy story
still works wherever it has a row at 5, 8 or 11; **Regenerate** on such a story
also rebuilds one version per group and moves the row it rewrites onto the
group's anchor.

The §6 guards run **once per story** — they judge the source article, which does
not vary by group — so the prompt guard costs one call, not three.

Without an API key the rule-based pipeline handles every group, using §9.2's
words-per-sentence limits as written: 14 for ages 5–7, 20 for 8–10, 28 for
11–14. So the slider still changes the text offline, exactly at the group
boundaries.

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
budget times three, because each story is rewritten for every reading group — so
the default of 10 stories is 30 calls, about $0.01 a day. Several guards keep
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

## Reading stories aloud

Stories used to be spoken by the browser's own `SpeechSynthesis` voice. That was
free and offline, but the voice was whatever the reader's operating system
happened to ship — not a decision worth leaving to chance for a product read by
children. The server now synthesises the audio, so every child hears the same
reviewed script in the same voice.

```
web                       server                          provider
─────────────────────────────────────────────────────────────────────────────
useStoryAudio             GET /api/articles/:id/audio
  <audio src=…>    ───▶     audioService                (business logic)
                              ├── cache hit? ───────▶  data/audio/<hash>.mp3
                              └── SpeechProvider ────▶  OpenRouter /audio/speech
```

The story being read aloud lights up: the whole card warms to the sun surface,
lifts on the pop shadow, and four little bars dance beside its number until the
audio ends. A child reads a card that changed colour long before they read a
glowing outline, and the bars are the part that says *sound*. It is a "this one
is playing" mark, not a read-along — the audio carries no sentence timings, so
nothing on screen can honestly point at the words being spoken. Under
`prefers-reduced-motion` the bars hold a still, staggered shape.

### Swapping the voice provider

`src/tts/types.ts` defines a `SpeechProvider`: text in, audio bytes out. It is
the only thing the rest of the server knows about. Nothing in `src/routes`,
`src/services` or `web/` names a provider, holds a key or knows what a voice id
looks like — so changing provider is three steps and no business-logic edit:

1. Write `server/src/tts/<name>Speech.ts` implementing `SpeechProvider`
   (`openRouterSpeech.ts` is the reference implementation).
2. Add one line to the `PROVIDERS` registry in `server/src/tts/index.ts`.
3. Set `TTS_PROVIDER=<name>` in `server/.env`.

A provider reads its own configuration from `src/env.ts`, which is why its key
and its voice vocabulary never leak into a shared options type.

### Configuration

| Setting          | Default                 | Why                                                          |
| ---------------- | ----------------------- | ------------------------------------------------------------ |
| `TTS_PROVIDER`   | `openrouter`            | Which module in `src/tts` speaks                             |
| `TTS_ENABLED`    | `true`                  | `false` turns the player off; nothing is synthesised or paid |
| `TTS_MODEL`      | `microsoft/mai-voice-2` | Provider-specific model id                                   |
| `TTS_VOICE`      | `en-US-AvaNeural`       | Provider-specific voice id — **must match the model**        |
| `TTS_MAX_CHARS`  | `2000`                  | Scripts are truncated first; TTS is billed by input length   |
| `TTS_TIMEOUT_MS` | `60000`                 | Synthesis takes seconds, unlike a chat completion            |

The OpenRouter provider reuses `OPENROUTER_KEY` — same account, same bill.

> **OpenRouter does not serve OpenAI's TTS models.** `openai/gpt-4o-mini-tts`
> answers `400 Model ... does not exist`, and `openai/gpt-audio-mini` is a
> streaming chat model rather than a speech endpoint. The models that do work on
> `/audio/speech` are `microsoft/mai-voice-2` (voice `en-US-AvaNeural`),
> `x-ai/grok-voice-tts-1.0` (voice `Eve`) and `mistralai/voxtral-mini-tts-2603`
> (voice `en_paul_neutral`). A voice id from the wrong model is a 400.

Check it:

```bash
cd server
npm run tts:check    # synthesises a real published story and writes tts-check.mp3
```

### Paying once

Audio is cached in `server/data/audio`, content-addressed by a hash of the
script, provider, model, voice and format. So a story is paid for once rather
than once per listener, and invalidation is free: an editor rewriting a script,
or a new `TTS_VOICE`, simply produces a different key. The directory is safe to
delete at any time.

Measured on the default model: about **1.6s** to synthesise a 335-character
script, **5ms** to serve it from cache. Only the first listener of a story
waits, which is why the play button has a real loading state.

---

## Prompts and the sandbox

Prompt wording is the highest-leverage thing in this project. Strengthening the
safety criteria in one prompt moved classification from 2/5 to 5/5 correct on a
fixed set of test articles — same model, same single call, same cost.

`/admin/sandbox` is the tool for that work:

- pick a prompt (generic, a reading-group override, or the safety guard) and an article
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

`npm run db:seed` never overwrites a prompt, so an improved seeded prompt reaches
an existing database through `npm run db:init` instead: a stored prompt that is
still, word for word, a seed this project once shipped is swapped for the
current one, and a prompt you have edited or removed is left exactly as it is.
(This is how a database seeded before the prompt asked for a spoken version
starts producing one.) To run just that step and see what it found:

```bash
npm run db:update-prompts   # refresh untouched seeded prompts and report each one
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
already has rows in it. The same run refreshes any seeded prompt that has not
been edited since it was seeded (see `src/db/refreshSeededPrompts.ts`).

| Table                               | Holds                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| `sources`                           | Feeds to scrape, plus a `manual` row for hand submissions |
| `raw_articles`                      | Original articles as fetched; waiting while `simplifiedAt` and `dismissedAt` are both NULL |
| `kid_articles`                      | Rewritten stories, one row per reading age, and their review status |
| `guard_config`                      | Deny-list and the safety-guard prompt                     |
| `translation_prompt_config`         | Live simplification prompts                               |
| `prompt_drafts` / `prompt_versions` | Sandbox drafts and promotion history                      |
| `app_settings`                      | Default reading age, scrape times, simplification budget  |
| `admin_users`                       | The single admin account (bcrypt)                         |
| `scrape_runs`                       | What each scrape stored, simplified, versioned and left raw |

Some constraints are load-bearing rather than decorative: a `published` row must
have a `publishedAt`; deleting a source with stored articles is refused (disable
it instead); and JSON columns are checked with `json_valid`.

---

## Tests

```bash
cd server && npm test    # 722 tests
cd web    && npm test    # 288 tests
```

Both suites are offline and free. Each server suite gets its own temporary
database and port, RSS tests serve a feed from a local HTTP server, and
`vitest.config.ts` hard-sets `LLM_ENABLED=false` so **no test can call a paid
API** — the LLM path is driven by a stub instead. It also sets
`LOG_LEVEL=silent`; the one suite that asserts on log lines passes its own
in-memory logger to `createApp`.

`npm run typecheck` in either package. Note that `tsconfig.json` currently
covers `src` only, so files under `server/scripts/` are not typechecked.

---

## Logging

The server logs with [pino](https://github.com/pinojs/pino), from one logger
in `src/logger.ts`. Every line goes to a JSON file and, in development, to the
terminal as well:

- **File** — `data/logs/server.N.log`. A new file starts when the current one
  reaches 5 MB, and the newest ten are kept, so the directory never grows
  past ~50 MB.
- **Terminal** — coloured and readable with `LOG_PRETTY=true` (the default);
  raw JSON with `LOG_PRETTY=false` for a process manager to capture.

Every request writes two lines — `request started` and `request completed` —
rather than one, so a request that hangs still shows up: it is a `started`
with no `completed`. Both carry the same `reqId`, which is also returned as
the `X-Request-Id` response header, so a failure someone reports can be
found in the file. A client that disconnects before the response finishes
gets `request aborted` instead.

Errors are logged in `errorHandler`, the one place they all pass through:

| what                          | level   | carries                     |
| ----------------------------- | ------- | --------------------------- |
| `AppError` (400/401/404/409)  | `warn`  | status and the message      |
| anything else (500)           | `error` | type, message, full stack   |

Routes log nothing themselves. Background work — scrape runs, the scheduler,
auto mode, speech synthesis — logs through `logger.child({ area })`, so
`area: "scrape"` filters a whole job. The `Authorization` header is redacted
and request bodies are never logged.

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
| `LOG_LEVEL`       | `info` — `silent` turns logging off            |
| `LOG_DIR`         | `data/logs` (relative to `/server`)            |
| `LOG_PRETTY`      | `true` — `false` for raw JSON on stdout        |

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
  logger.ts           the pino logger: rolling file plus pretty terminal
  core/               domain types and errors — no express, no sqlite
  db/                 schema.sql, connection, seeds, repositories (all SQL lives here)
  http/               middleware (auth, request logging, errors) and validation
  pipeline/           the safety guard and rule-based simplification
  llm/                the OpenRouter client and response parsing
  ingestion/          RSS fetching, parsing, scheduling
  services/           use cases: submit, regenerate, sandbox, scrape runs,
                      simplification (simplifyService, simplifyBudget, jobLock)
  tts/                the speech provider registry, its contract, and the audio cache
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

- **Whole-episode audio.** Individual stories are read aloud for real (see
  _Reading stories aloud_), but nothing stitches the day's stories into one
  file, so the big play button at the top of `/podcast` is still a placeholder.
- **Read-along highlighting.** The old browser-voice player highlighted the
  sentence being spoken, because each sentence was its own utterance. One audio
  file per story has no such boundaries; the playing card glows instead, and the
  highlight comes back once timings are carried alongside the audio.
- **Multiple admin accounts / roles.** One shared account by design (§2.2).
- **Translations, mobile apps.** Out of scope (§14).

One known ambiguity: PRD §11.1 says the public reading-age slider should drive
the default age for new simplifications, but §4.4 assigns that setting to admin
settings. Since `/settings` has no auth, the admin slider owns
`app_settings.defaultAge`; the public slider drives the badge and is
browser-local.
