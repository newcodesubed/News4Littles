# One version per reading band — design

**Date:** 2026-09-14
**Status:** implemented
**Supersedes:** the "one LLM call per age" decision in
`2026-09-09-per-age-versions-design.md` §2. Everything else in that document —
story-scoped actions, the grouped queue, the slider driving the feed — stands.

## 1. Problem

Every story was simplified ten times, once per age 5–14, and stored as ten
`kid_articles` rows. Measured against what a reader actually gets:

| | per story | per run of 10 stories |
|---|---|---|
| model calls | 10 (+1 guard) | 100 |
| input tokens | the article × 10 | the article × 100 |
| rows to store, review and regenerate | 10 | 100 |
| texts an editor reads before one Publish | 10 | — |

A 6-year-old and a 7-year-old do not need different rewrites. The ten versions
were near-identical in practice, and the rule-based fallback had to be bent to
`age * 2` words per sentence purely so that ten rows would not be byte-identical.

## 2. Decision

A story is written once per **reading band**, and the bands are the three §9.2
already defines for the rule-based pipeline:

| band | `ageTarget` stored | words/sentence (fallback, §9.2) |
|---|---|---|
| 5–7 | 5 | 14 |
| 8–10 | 8 | 20 |
| 11–14 | 11 | 28 |

Three calls and three rows per story — a 70% cut in calls, tokens and rows.

### Why these three

They are the PRD's own split (§9.2: "<=7 → 14; <=10 → 20; else 28"), so the
LLM path and the fallback now agree on what a version *is*. They also match
how reading stages are commonly grouped (early readers / fluent readers / older
children), which is what a prompt can be meaningfully written for. Nothing else
in the product argued for a finer split.

### Why the youngest age is the anchor

`kid_articles.ageTarget` keeps its column and its `CHECK (5..14)`; a version
simply stores its band's youngest age. Reading down is safer than reading up for
a children's product, so `{{age}}` in the prompt — "words a {{age}}-year-old
knows" — is pitched at the youngest reader, and the stored value reads
naturally in the UI ("For ages 5–7"). No schema change.

### Why not one combined call

Rejected again, for the reason the previous spec gave: every stored prompt
template embeds `{{body}}` and its own JSON envelope, so a combined call either
sends the article three times (no saving) or mangles the templates and loses
per-band prompt control and the sandbox's fidelity to production (§7.4).

## 3. What changed

**Domain.** `AGE_BANDS`, `AGE_BAND_ANCHORS`, `bandForAge`, `isAgeBandAnchor`,
`formatAgeBand` in `server/src/core/article.ts`, mirrored in
`web/src/lib/ageBands.ts`. One place to change if the bands ever do.

**Pipeline.** `simplifyArticleForAllAges` became `simplifyStory`, which takes
`bands` and `perBand` instead of `ages` and `perAge`. `simplifyArticle` is
untouched — one article, one `ageTarget`, one version — which is what keeps
the sandbox on the production code path. `maxWordsForAge` reads the band's
limit, restoring §9.2 as written.

**Prompt.** A new template variable `{{ageRange}}` renders the band ("5 to 7"),
so the generic prompt can say "for children aged 5 to 7" while still pitching
vocabulary at a 5-year-old. `TEMPLATE_VARIABLES` moved next to `renderPrompt`,
so the list the editor sees cannot drift from what is substituted. Overrides
are keyed by band anchor; the seeded age-6 override became the 5–7 band's,
keyed `'5'`.

**Validation.** Anything that *stores* an `ageTarget` — submit, edit, a prompt
override or draft's scope — must be a band anchor (`requireAgeTarget`,
`requireAge` in the sandbox). Anything that names a *reader* — `defaultAge`,
`?age=` — accepts any of 5–14 (`requireReaderAge`) and is resolved to a band
where it is used.

**Reads.** `GET /api/articles?age=N` resolves N to its band's anchor and
matches exactly, as before. The repository is unchanged; the route does the
resolving.

**Regenerate.** Groups a story's existing rows by band and rebuilds one
version per band. The rewrite targets the row already at the anchor, else the
youngest row in the band, so applying it moves a pre-band row onto the anchor.
Surplus rows are left for the migration rather than deleted from a preview
flow whose contract is "writes only what you ticked".

**Migration.** `scripts/migrate-age-bands.ts` (logic in
`src/db/migrateAgeBands.ts`, unit-tested) collapses every story onto its
anchors — keep the anchor row, else the youngest, delete the rest — and re-keys
overrides and drafts. Dry run by default; `--apply` to write; one transaction;
idempotent. `prompt_versions` is append-only history and is left alone.

**Web.** Every place an editor picks *which* version (submit, edit, prompt
overrides, sandbox variant) offers bands. Labels say "Ages 5–7", never
"Age 5". The public slider is unchanged: one year at a time, 5–14.

## 4. Not changed

- The slider granularity. Readers still pick an exact age; it selects a band.
- The schema. `ageTarget BETWEEN 5 AND 14` still holds; the anchor invariant is
  enforced in code, because tightening the CHECK needs a table rebuild in
  SQLite and the code path is the only writer.
- Story-scoped actions, the grouped queue, the auto-approve judge (it reads the
  youngest version, now the 5–7 band's).

## 5. Testing

Server: 604 tests, including band boundaries, `{{ageRange}}`, anchor-only
validation on submit/edit/sandbox, three calls per story, per-band fallback,
regenerate over pre-band stories, and the migration's keep/move/delete rules.
Web: 267 tests, including the band selects, the labels, and the anchor helper
that mirrors the server's.
