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
| Generation | One LLM call **per age** — ten per story |
| Review | One screen per story, all versions, approved together |
| Missing version | Nearest published version, labelled |
| Row actions | Existing endpoints become story-scoped; Edit stays per-version |
| Prompt | Unchanged. `selectPrompt` already picks an age's override, or the generic prompt with `{{age}}` substituted |

### Feasibility, measured not assumed

From OpenRouter's model API for the configured `google/gemini-2.5-flash-lite`:

| | |
|---|---|
| Context length | 1,048,576 tokens |
| Max output | 65,535 tokens |
| Pricing | $0.10/M input, $0.40/M output |

Cost is about **$0.0029 per story** — ten calls, each re-sending the article —
or **~$0.87/month** at the budget of ten stories a day. `LLM_MAX_TOKENS` stays
at 1500: each call returns one version, exactly as today.

**A combined single call was designed first and rejected.** It would have cost
~$0.47/month, but every stored prompt template is a complete standalone prompt
that embeds `{{body}}` *and* its own "Return ONLY a JSON object" envelope
(`seed-prompts.ts:30, 39, 88, 98`). Assembling ten of them into one call means
either embedding the article ten times — which destroys the saving that
justified the design — or mangling each template with a back-reference and an
overriding format instruction, producing a prompt no editor could reason about.

The saving at stake was **40 cents a month**, against losing per-age prompt
control and the sandbox's fidelity to production (§7.4 requires the sandbox to
run the same code path production runs). Ten calls it is.

The real cost is time, not money: ten stories × ten ages is 100 sequential
calls, so a run goes from roughly 30 seconds to roughly 5 minutes. It is a
background job that already warns runs take minutes. Limited concurrency is a
later option, deliberately not in this design.

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

### 4.2 Ten calls

`simplifyArticle` keeps its signature and behaviour exactly as they are — one
article, one age, one version. A new `simplifyArticleForAllAges` loops the ages
and calls it, collecting `KidArticle[]`.

No new parsing: `parseLlmContent` is unchanged. No new prompt code:
`selectPrompt` and `renderPrompt` are unchanged. Beyond the loop and the
transaction, the only change inside `simplifyArticle` is an injection point for
the shared prompt guard (§4.4).

### 4.3 Prompts — nothing to change

`selectPrompt(generic, ageOverrides, age)` (§9.1 step 1) already returns that
age's override when one exists, and otherwise the generic prompt with
`{{age}}` substituted. Verified against the real function: with overrides for
6 and 12 present, ages 5, 10 and 14 fall through to generic and render as
"rewrite for a 10-year-old".

The live config currently holds **no** age overrides, so all ten ages use the
generic prompt with a different age substituted. That already differentiates
the output — the prompt says "use everyday words a {{age}}-year-old knows" —
so the feature works with no prompt authoring, and an override can be added
for any single age later.

This is also what keeps the sandbox honest: it tests one article at one age
against one prompt draft, which is exactly the unit production now uses.

### 4.4 Guards

The deny-list (§6.1) and prompt guard (§6.2) judge the **source** article,
which does not vary by age, so both should run **once per story** — one
prompt-guard call, not ten.

That needs a change, because `runPromptGuard` is currently called *inside*
`simplifyArticle`, so a naive loop over ten ages would make ten guard calls and
double the cost of the whole feature. `SimplifyOptions` gains an optional
`promptGuard?: PromptGuardOutcome`: when supplied, `simplifyArticle` uses it
instead of making its own call. `simplifyArticleForAllAges` runs the guard once
and passes the same outcome into all ten. Every existing caller omits the
option and is unaffected.

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

With ten independent calls, a failure is per-age: that age falls back to the
rule-based pipeline and the other nine keep their LLM versions. So a story may
legitimately be nine parts LLM and one part fallback, and the review screen has
to show the engine **per version** rather than per story, so an editor can see
which age got the weaker treatment.

### 4.7 Budget interaction

`app_settings.simplifyBudget` still counts **stories**, and that meaning is
now load-bearing: a budget of ten means ten stories and therefore **100
simplification calls**, plus one prompt-guard call per story when §6.2's guard
is enabled. The budget no longer bounds LLM calls directly, and the settings
page must say so, or an editor will set 10 expecting 10 calls.

Run reporting gains a version count alongside the story count, so the page can
read "10 stories, 100 versions".

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

- A single age's call failing falls **that age** back to the rule-based
  pipeline, with the reason recorded as today (§9.1 step 4). The other nine are
  unaffected — a benefit the combined call could not offer.
- The prompt guard failing contributes no verdict rather than a made-up one,
  exactly as now.
- A database failure while writing a story's ten versions rolls back all ten and
  leaves `simplifiedAt` NULL, so the story stays in the backlog and is retried.
- An age the model omits is treated as a malformed response (§4.6), not
  silently backfilled.

## 8. Testing

- **Per-age prompt selection** — an age with an override uses it; an age
  without one uses the generic prompt with its own age substituted.
- **Generation** — one story yields ten rows with distinct `ageTarget`s, all
  `pending_review`; ten simplification calls but only one prompt-guard call; a
  deny-list hit raises every version; one age failing leaves the other nine on
  the LLM engine; the whole story rolls back on a write failure.
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
