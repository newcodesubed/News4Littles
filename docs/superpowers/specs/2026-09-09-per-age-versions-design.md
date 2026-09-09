# One version per reading age — design

**Date:** 2026-09-09
**Status:** approved, ready for an implementation plan
**Depends on:** `2026-09-09-simplification-budget-design.md` (the budget and the
raw-article backlog it introduced)

## 1. Problem

`/settings` offers a reading-age slider from 5 to 14 (§3.6), and moving it
changes nothing but a badge. Every story exists in exactly one version, at
whatever `app_settings.defaultAge` happened to be when it was simplified — so a
5-year-old and a 14-year-old read identical text. The control implies a promise
the content cannot keep.

Verified in the live database: 33 kid articles, one version each, at seven
different `ageTarget` values (6, 7, 8, 9, 11, 12, 13) — an artefact of the
default age changing over time rather than a deliberate range.

## 2. What this builds

One version per age, 5 to 14 — ten versions per story — so the slider selects
real content. Requested as a product requirement, not a preference.

### Decisions taken

| Question | Decision |
|---|---|
| Granularity | One version per age, 5–14 (ten per story) |
| Generation | One LLM call returning all ten versions |
| Review | One screen per story, all versions, approved together |
| Missing version | Nearest published version, labelled |
| Row actions | Existing endpoints become story-scoped; Edit stays per-version |
| Prompt | `genericPrompt` + all ten `ageOverrides` stay editable and are assembled into one call; the JSON-shape scaffolding lives in code |

### Feasibility, measured not assumed

From OpenRouter's model API for the configured `google/gemini-2.5-flash-lite`:

| | |
|---|---|
| Context length | 1,048,576 tokens |
| Max output | 65,535 tokens |
| Pricing | $0.10/M input, $0.40/M output |

Ten versions need roughly 4,400 output tokens, so `LLM_MAX_TOKENS` rises from
1500 to 8000 — comfortable headroom, nowhere near the ceiling. The same setting
caps the single-version calls the sandbox and Regenerate make; raising it is
harmless there because `max_tokens` is a ceiling, not a target, and those
responses stay the size they are today.

Cost is about **$0.00155 per story**, or **~$0.47/month** at the budget of ten
stories a day. Ten separate calls would cost about 1.9× that, because the
article body is the bulk of the input and would be re-sent ten times. That is
the entire reason for the single-call design.

## 3. Phase 0 — the public API (done, shipped separately)

Found while reading the read path this feature changes: `GET /api/articles` with
no `status` returned **every** kid article, and the route passed a
caller-supplied `status` straight through, so an unauthenticated request could
ask for `pending_review`. Measured against the live database: 33 articles
returned, of which 20 were unreviewed and 3 rejected. `GET /api/articles/:id`
had the same gap.

Fixed in commit `1b5e730` before any of this feature, because it defeats §2.2 —
nothing reaches a child without a human reading it first. `listPublished()` and
`findPublishedById()` hardcode the status in SQL rather than accepting it as an
argument, so the guarantee cannot be lost by a forgetful caller. An unpublished
id answers 404, not 403: a 403 confirms the story exists and lets someone
enumerate the review queue.

## 4. Phase 1 — generate and store ten versions

### 4.1 Data model

No schema change. `kid_articles` already permits this, and its own comment says
so: *"No UNIQUE (originalId, ageTarget): one raw article may yield several age
versions, per the per-age prompt overrides in §9 and the age filter in §4.2."*
Ten rows share an `originalId`, one per `ageTarget` 5–14.

Ten stories per run × ten versions = 100 rows per run. Trivial for SQLite.

### 4.2 The combined call

A new `parseLlmVersions` expects:

```json
{ "versions": [ { "ageTarget": 5, "kidHeadline": "...", "summary": "...", ... }, ... ] }
```

and requires all ten ages present. The existing single-version
`parseLlmContent` stays, because the sandbox (§7.4) and Regenerate both work on
one age at a time.

`simplifyArticle` keeps its current single-version signature for those callers.
A new `simplifyArticleForAllAges` shares the guard and fallback logic and
returns `KidArticle[]`.

### 4.3 Prompt assembly

The editor keeps editing `genericPrompt` and the ten `ageOverrides` entries.
Those overrides become ten labelled sections inside one prompt — the same
instructions that would have driven ten separate calls, delivered in one.

The scaffolding around them (the "return one object per age, in this JSON
shape" instruction) is assembled in code and is deliberately **not** editable.
An editor who broke the generic prompt produces a bad rewrite; an editor who
broke the JSON instruction would fail every simplification at once.

### 4.4 Guards

The deny-list (§6.1) and prompt guard (§6.2) judge the **source** article,
which does not vary by age, so both run **once per story** — one prompt-guard
call, not ten.

The model returns a safety verdict per version, and `strictest()` combines it
with the story-level verdicts. So a deny-list hit forces every version to the
stricter level, while a story with no hits may still be `adult-nearby` at age 6
and `calm` at age 14 on the model's own judgement.

### 4.5 Atomicity

All ten versions and the `simplifiedAt` claim commit in **one transaction**.
This deliberately differs from the budget feature's per-article commits: a story
holding four of ten versions is a broken state for group-approve, and there is
no sensible way to display or publish it. Resumability moves from per-article to
per-story, which is still enough for a batch to survive a crash.

### 4.6 Fallback

`maxWordsPerSentence` changes from three bands to `age * 2`. This reproduces all
three of §9.2's anchors exactly — age 7 → 14, age 10 → 20, age 14 → 28 — while
giving every age its own value. Without it, the rule-based pipeline would emit
three distinct texts across ten rows and the slider would still be lying
whenever the LLM was unavailable.

Ages below the old first anchor do change: age 5 goes from 14 words to 10. That
is the point.

If the combined response is malformed, or is missing any of the ten ages, the
**whole story** falls back to the rule-based pipeline. One engine per story is
easy to reason about and gives the editor a single clear flag; a story that is
seven parts LLM and three parts fallback is not.

### 4.7 Budget interaction

Unchanged: `app_settings.simplifyBudget` still counts **stories**, and a run
still makes **one simplification call per story** — plus one prompt-guard call
per story when §6.2's guard is enabled, exactly as today. So a budget of ten is
ten calls, or twenty with the guard on; it is not multiplied by the ten
versions. That is the whole point of the single-call design: with ten calls per
story the budget's meaning would have had to change from stories to calls.

Run reporting gains a version count alongside the story count, so the settings
page can say "10 stories, 100 versions".

## 5. Phase 2 — review grouped by story

`GET /api/admin/stories` returns one row per `originalId` with a nested
`versions: AdminArticle[]`. The flat `GET /api/admin/articles` stays as it is —
§4.2's age filter and `distinctAgeTargets()` both want per-version rows.

Tab counts become story-level (`COUNT(DISTINCT originalId)` per status), or the
Pending badge would read 100 where the editor has ten stories to read.

Row actions become **story-scoped**: `PATCH /articles/:id/publish` publishes
every version sharing that story, and reject, unpublish and delete likewise.
The URLs and the admin wiring are unchanged; the semantics are, and both the
route comments and the README must say so. Bulk actions expand the selected
version ids to their stories.

**Edit stays per-version**, so a single age's wording can be fixed without
touching the other nine. `editedByHuman` therefore stays a per-version flag.

Because publish/reject/delete move all versions together, a story's versions
share one status, which is what makes story-level grouping and counting sound.

`ViewArticleDialog` gains an age selector so the editor can read every version
before approving — the point of the one-screen choice, and what keeps the §2.2
guarantee true rather than nominal.

## 6. Phase 3 — the slider drives the feed

`GET /api/articles?age=N` returns one entry per story: the version for age N, or
the nearest published one.

```sql
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY originalId ORDER BY ABS(ageTarget - @age), ageTarget
  ) AS rn
  FROM kid_articles WHERE status = 'published'
) WHERE rn = 1 ORDER BY createdAt DESC
```

Window functions need SQLite 3.25+; the pinned better-sqlite3 reports 3.49.2.

The `ageTarget` tie-break makes ties prefer the **younger** version — age 9 with
8 and 10 available gets 8 — because reading down is safer than reading up for a
children's product.

`N` is validated as an integer 5–14 and bound as a parameter, never
interpolated. Absent or invalid, it falls back to `app_settings.defaultAge`.
The status filter stays hardcoded, as Phase 0 established.

The response carries `ageMatched: boolean` and the actual `ageTarget`, so the UI
can show a quiet "written for a different age" note rather than silently
implying a match. Both are response-only fields, added alongside §8.3's
`KidArticle` shape rather than stored on it.

A story with no published version at any age is absent entirely — the
`WHERE status = 'published'` inside the subquery removes it before the
partition, so it cannot appear as an empty row.

**`GET /api/articles/:id?age=N` needs the same resolution.** The id names one
version, but a reader who moves the slider on the story page must get that
story's sibling version, not a dead end. So the route resolves the id to its
`originalId`, then applies the same nearest-age selection within that story.
Without this the slider works on the feed and silently stops working one click
deeper.

`SettingsContext` already holds `readingAge` in localStorage; it starts passing
it to the API. `Home` and `StoryDetail` refetch when it changes.

The existing 33 single-version articles are served by the nearest-age logic, so
they keep working — they simply will not change as the slider moves until they
are re-simplified.

## 7. Failure handling

- A malformed or incomplete combined response falls the story back to the
  rule-based pipeline, with the reason recorded as today (§9.1 step 4).
- The prompt guard failing contributes no verdict rather than a made-up one,
  exactly as now.
- A database failure while writing a story's ten versions rolls back all ten and
  leaves `simplifiedAt` NULL, so the story stays in the backlog and is retried.
- An age the model omits is treated as a malformed response (§4.6), not
  silently backfilled.

## 8. Testing

- **Prompt assembly** — all ten ages appear; each age's override is attached to
  its own age; the generic prompt is used where an override is absent.
- **Multi-version parsing** — a well-formed ten-version response; a response
  missing an age; malformed JSON; an unexpected extra age.
- **Generation** — one story yields ten rows with distinct `ageTarget`s, all
  `pending_review`; one prompt-guard call, not ten; a deny-list hit raises every
  version; the whole story rolls back on a write failure.
- **Fallback per age** — `age * 2` at every age, and the three §9.2 anchors
  asserted explicitly; ten fallback versions differ from one another.
- **Story-scoped actions** — publishing one version publishes all ten;
  rejecting, unpublishing and deleting likewise; editing one leaves the other
  nine untouched.
- **Story grouping** — one row per story with ten nested versions; counts are
  story-level, not version-level.
- **Nearest age** — exact match preferred; nearest when absent; ties prefer the
  younger; unpublished versions never selected; an out-of-range or non-numeric
  `age` falls back to the default rather than erroring.
- **Public path** — `?age=` never reveals an unpublished version; one entry per
  story, never ten.
- **Web** — moving the slider refetches and the text changes; the
  out-of-band label appears only when `ageMatched` is false.

## 9. Implementation sequencing

Each phase leaves the application working and is worth its own plan:

1. **Phase 1** is testable with no UI change at all — a scrape produces ten
   versions per story and the existing queue shows them as ten rows. Ugly, but
   correct and shippable.
2. **Phase 2** makes that queue usable again. It depends on Phase 1 existing but
   touches no public code.
3. **Phase 3** is the only phase a reader sees, and it depends on both.

Phase 1 should not be merged and left alone for long: between Phase 1 and Phase
2 the review queue shows ten rows per story, which is worse for the editor than
what exists today.

## 10. Out of scope

- Per-age *images* or audio. Text only.
- Re-simplifying the existing 33 articles into ten versions each. The
  nearest-age logic covers them; re-simplify by hand if wanted.
- Letting a reader pick a version other than their age band.
- Per-version publish scheduling. All versions of a story share one status.
