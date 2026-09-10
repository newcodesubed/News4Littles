# Story-scoped regenerate — design

**Date:** 2026-09-10
**Status:** implemented — see `docs/superpowers/plans/2026-09-10-story-scoped-regenerate.md`

## 1. Problem

Regenerate rebuilds one version of a story and leaves the other nine stale.

A story is one raw article's ten age versions (§3.6), and §5 made publish,
reject, unpublish and delete story-scoped: they take any version's id and move
every version with it. Regenerate did not follow. `AdminReview.tsx:290` passes
`story.versions[0].id` — deterministically the youngest, age 5 — and the server
side is per-version end to end: `regenerateArticle` calls `simplifyArticle`
with `{ ageTarget: current.ageTarget, id: current.id }`, and
`applyRegeneration` is a single `UPDATE … WHERE id = @id`.

The per-age-versions phase 2 plan named this and deferred it:

> Regenerate stays per-version: it regenerates the youngest version only.
> Whether it should regenerate all ten is a real question, deliberately
> deferred.

What an editor gets today: fix the prompts, hit Regenerate, apply, publish — and
one freshly generated age-5 version goes live beside nine versions built from
the old prompt. Shared-ish fields (`category`, `safety`, `contentWarnings`) can
disagree between ages of the same story, and only the age-5 row has its
`editedByHuman` flag cleared.

**A second defect, fixed here because this design has to touch it.**
`articleActions.ts:104` implements apply by calling `regenerateArticle` a
*second* time and writing that result. So apply doubles the model spend, and
because the model is non-deterministic it can write text the editor never saw in
the diff. At ten versions that becomes twenty calls per applied story, so it
cannot survive into this feature.

## 2. What this changes

Regenerate becomes story-scoped and job-shaped:

- **Preview** — one background job re-runs the whole story: one shared §6.2
  prompt-guard call plus one simplification per existing age. The client polls,
  the row shows `Regenerating… 4/10`. Nothing is written.
- **Choose** — a tabbed dialog, one tab per age, each with a tick box. Ages
  edited by a person arrive unticked and badged.
- **Apply** — writes the ticked ages from the *held* preview, in one
  transaction. No further model calls.

### Decisions taken

| Question | Decision |
|---|---|
| Sync or job | Background job with polling, the shape `startSimplifyJob` already uses |
| Where the preview lives | Module-level job state in memory; no staging table |
| Apply scope | Per-age tick boxes, all ticked by default; ticked ages only |
| Human-edited versions | Previewed, but **unticked** by default and badged |
| Apply semantics | Writes the previewed content; never re-runs the pipeline |
| Old per-version endpoints | Removed, along with `regenerateArticle.ts` |
| Which ages | The story's **existing** versions, not `ALL_AGES` |

### Rejected alternatives

**Stage the preview in a table.** A `regenerated_versions` table would survive a
restart and allow several stories in flight, at the cost of a migration, an
expiry rule and a repository. The app is explicitly one process with one admin
(§2.2), and nothing is written until apply, so a lost preview costs one re-run
of something the editor was already waiting on. YAGNI.

**Synchronous request.** Ten sequential model calls is minutes in one HTTP
request, with no progress and no way to survive a proxy timeout. Both
comparable features (scrape "Run now", the manual simplify batch) already
refused this shape for that reason.

**Apply only the ages that differ, no tick boxes.** Fewer writes, but an editor
who dislikes one age's rewrite could not decline it while taking the other nine.

## 3. Server

### 3.1 `services/regenerateStory.ts` (new; replaces `regenerateArticle.ts`)

Deliberately the same shape as `simplifyService.ts`, so the two read alike.

```ts
export interface RegeneratedVersion {
  ageTarget: number;
  /** The stored row this age would replace. */
  current: AdminArticle;
  /** Identity and lifecycle fields carried over, so the diff shows only
   *  what regeneration would actually change. */
  generated: AdminArticle;
  engine: string;
  model?: string;
  /** Set when THIS age fell back to the rule-based pipeline (§9.2). */
  fallbackReason?: string;
}

export interface RegenerateJobState {
  id: string;
  originalId: string;
  /** The youngest version's headline, as the progress line's label. */
  kidHeadline: string;
  startedAt: string;
  finishedAt?: string;
  /** The story's existing versions, ascending by age. */
  ages: number[];
  /** Ages attempted so far, for "Regenerating… 4/10". */
  done: number;
  running: boolean;
  versions: RegeneratedVersion[];
  /** Spent whether or not the editor applies. */
  costUsd: number;
  /** Only for a thrown failure — a missing raw article, a database error. */
  error?: string;
  /** Set once applied. The server refuses a second apply of the same
   *  preview once this is set, rather than relying on the client to stop
   *  offering apply. */
  appliedAges?: number[];
}

export function startRegenerateJob(db: Database, id: string, options?: RegenerateOptions): RegenerateJobState;
export function getRegenerateJob(): RegenerateJobState | null;
/** Test seam and Discard: forget the preview and let go of the lock. */
export function resetRegenerateJob(): void;
export function applyRegeneratedVersions(db: Database, jobId: string, ages: number[]): AdminStory;
```

```ts
export interface RegenerateOptions {
  /** Test and sandbox seam; without one, simplifyArticle reads LLM_ENABLED. */
  client?: OpenRouterClient;
  now?: () => string;
}
```

Module-level `current`, one job at a time, `acquireJob('regenerate')` with
`releaseJob()` in a `finally` — a leaked lock would block every later scrape and
batch. `JobKind` in `jobLock.ts` gains `'regenerate'` with its `HOLDER` and
`WANTED` strings. The lock is not decoration: a scrape run's simplification
phase writes `kid_articles` rows for the same story, so the two must stay
mutually exclusive.

**`ages` comes from the story.** Pre-phase-1 stories hold a single version.
Regenerate refreshes the versions that exist and never invents an age, which
also makes the dialog's tab count data-driven — the same assumption `StoryRow`
already makes with `story.versions.length > 1`.

**Apply reuses the held preview.** `applyRegeneratedVersions` looks up each
ticked age in `job.versions` and calls the existing per-version
`articles.applyRegeneration(version.generated.id, version.generated)` for each,
all inside one `db.transaction`, so a story cannot end up half-applied. It
returns `articles.findStory(job.originalId)` so the queue row refreshes in one
round trip.

**Per-age failure is not an error.** `simplifyArticle` never throws: it falls
back to the rule-based pipeline and flags why. A weak age therefore arrives as
`fallbackReason` on that version and surfaces on that tab. `job.error` is
reserved for a thrown failure, which ends the job with `running: false` and the
lock released.

### 3.2 One additive change to `simplifyArticleForAllAges`

The function hardcodes `ALL_AGES` and passes one `options` object to every age,
so `options.id` would collide: all ten versions would claim the same row id.
Three options are added, and the ingest caller is unaffected:

```ts
/** Which ages to build. Defaults to ALL_AGES. */
ages?: number[];
/** Per-age identity, so a regeneration writes back to the stored rows. */
perAge?: (ageTarget: number) => { id?: string; now?: string } | undefined;
/** Ages attempted so far, for progress polling. */
onProgress?: (done: number) => void;
```

The service passes `perAge: (age) => ({ id: byAge[age].id, now: byAge[age].createdAt })`.

Extending the existing loop rather than writing a second one in the service is
the point: this is the only place that knows "ten calls, one shared prompt-guard
call, fallbacks prefixed by age", and a copy would drift from it.

### 3.3 Routes (`routes/admin/articleActions.ts`)

`POST /articles/:id/regenerate` and `POST /articles/:id/regenerate/apply` are
removed. Four handlers replace them:

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/articles/:id/regenerate` | Any version's id resolves to the story, as publish and reject do. Starts the job, `202` with the state. `409` if any job holds the lock; `404` if the story does not exist. |
| `GET` | `/articles/regenerate/status` | `{ running, job }` — the same envelope the simplify batch already polls. |
| `POST` | `/articles/regenerate/apply` | Body `{ jobId, ages }`. Writes those ages; responds with the refreshed `AdminStory`. |
| `DELETE` | `/articles/regenerate` | Discard, so the server stops holding a dead preview. |

Apply validation, through the existing error classes:

- `409` when `jobId` is not the current job ("that preview is no longer the
  current one"), or the job is still running
- `400` on an empty `ages`, a non-integer age, or an age the job never previewed
- `404` when the story disappeared while the dialog was open

The regenerate handlers use `requireStory`/`findStoryState` like the other
story-scoped actions. `requireArticle` stays: Edit is still per-version and is
now its only caller, which is correct rather than dead code.

The module comment's SCOPE paragraph is rewritten: publish, reject, unpublish,
delete **and regenerate** are story-scoped; Edit remains the single exception,
so one age's wording can still be fixed without touching the others.

## 4. UI

### 4.1 `review/useRegenerateJob.ts` (new)

`AdminReview.tsx` is 380 lines and already owns three kinds of async state, so
the job lives in a hook: `{ job, start, apply, discard, notice }`. It polls
`/articles/regenerate/status` every 2s while `job.running`, reusing
`WaitingPanel`'s `POLL_MS` shape, and treats a dropped poll as retryable on the
next tick.

A poll returning `{ running: false, job: null }` means the server restarted
mid-run: the hook clears its state and sets
`⚠ The regenerate preview was lost. Try again.`

### 4.2 `AdminReview.tsx`

`openRegenerate` and the `regenerating` state go. The row action becomes
`onRegenerate: () => void regen.start(story.versions[0].id)` — the id
convention is unchanged, but now it resolves to the whole story rather than
silently meaning "age 5". Rows stay locked while the job runs, which is honest:
the server takes one job at a time. A successful apply triggers the existing
queue reload through the hook's `onApplied`.

### 4.3 `review/StoryRow.tsx`

The button reads `Regenerating… 4/10` from `job.done` / `job.ages.length` while
the running job belongs to this story.

### 4.4 `dialogs/RegenerateDialog.tsx` (rewritten)

Props become `{ job, onDiscard, onApply(ages: number[]) }`.

```
┌ Regenerate — review before applying ─────────────────────────┐
│ 10 versions re-run through the current prompts and guard      │
│ config. Nothing has been saved yet. Preview cost $0.0043      │
│                                        [ Untick all ]         │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ ☑ 5 •3  ☑ 6 •2  ☐ 7 ✎•4  ☑ 8 —  ☑ 9 •1  ☑ 10 •2  ☑ 11 … │ │  ← scrolls
│ └───────────────────────────────────────────────────────────┘ │
│  Age 7 · edited by a person · 4 field(s) would change         │
│  ┌─────────────┬──────────────────┬──────────────────┐        │
│  │ Field       │ Current          │ Regenerated      │        │
│  │ kidHeadline │ …                │ …                │        │
│  └─────────────┴──────────────────┴──────────────────┘        │
│  ✎ This age was edited by a person. Tick it only if you want  │
│    that wording replaced.                                     │
│                          [ Discard ]  [ Apply 9 of 10 ]       │
└───────────────────────────────────────────────────────────────┘
```

- `•n` is that age's changed-field count; `—` means no differences; `✎` means
  the stored version was edited by a person.
- The tab strip scrolls horizontally, so ten ages do not reflow the dialog.
- Ticks seed from `ages.filter((a) => !version.current.editedByHuman)`.
- Apply is disabled at zero ticks and its label counts them.
- An age with no differences stays ticked; writing it is a no-op, and hiding it
  would make the tab strip lie about what the story contains.
- The header count is `job.ages.length`, not a hardcoded ten, so a one-version
  story reads "1 version re-run".
- `onDiscard` is also the `Modal`'s `onClose`, so closing the dialog by any
  route discards the preview through the same path.
- A successful apply clears the hook's job, which closes the dialog and leaves a
  notice naming the ages written.

### 4.5 `dialogs/VersionDiff.tsx` (new)

Today's field table, lifted out unchanged, taking `{ current, generated }`. It
is already the right component — it was just trapped in a dialog that now has
tabs and tick boxes to own. Splitting keeps both files single-purpose, matching
the rest of `dialogs/`.

### 4.6 `admin/types.ts`

Gains `RegenerateJob` and `RegeneratedVersion`, mirroring the server types
beside the existing `SimplifyJob`.

## 5. Testing

TDD, red→green per step, in this order: pipeline options → service and lock →
routes → client types → hook → dialog.

### 5.1 `server/tests/regenerate-story.test.ts` (new)

Modelled on `simplify-service.test.ts`. The `regenerate (§4.2)` block in
`admin-actions.test.ts` is deleted and its carry-over assertions roll forward
here.

1. `202` with `ages` equal to the story's existing versions
2. a finished job has written nothing — every row byte-identical
3. the §6.2 prompt guard runs **once per story**, not once per age
4. each generated version is pinned to its stored row's `id` and `createdAt`
5. apply writes only the ticked ages; unticked rows unchanged, `editedByHuman`
   included
6. apply clears `editedByHuman` on the ages it writes
7. apply preserves `status`, `publishedAt`, `approvedBy` and the `raw.url`
   source link, per version
8. apply makes **no** further model calls
9. `409` on a stale `jobId` and on a still-running job; `400` on empty `ages`
   or an unpreviewed age
10. `409` when scrape or a simplify batch holds the lock, and a running
    regenerate blocks a simplify batch
11. a thrown failure (raw article deleted mid-job) sets `job.error`,
    `running: false`, and releases the lock
12. a one-version story regenerates exactly that age

### 5.2 `web/src/__tests__/admin-regenerate.test.tsx` (new)

Polling conventions from `admin-waiting.test.tsx`. `admin-dialogs.test.tsx`'s
"opens on the youngest version" is replaced.

1. the row button starts the job and shows `Regenerating… n/m` from polled status
2. the dialog opens on completion with one tab per age
3. human-edited ages arrive unticked and badged; the rest ticked
4. switching tabs shows that age's diff
5. Apply posts `{ jobId, ages }` with exactly the ticked ages
6. Apply is disabled at zero ticks, and its label counts them
7. Discard sends `DELETE` and closes without writing
8. a lost job surfaces the retry notice

### 5.3 Verification gate

`npm test` and `npm run typecheck` in both `server/` and `web/`.

## 6. Not in this phase

- **Filling missing ages.** A pre-phase-1 story with one version stays at one
  version; regenerate refreshes, it does not backfill.
- **Resurrecting a preview after a page reload.** The status endpoint would
  serve it, but offering a preview an editor did not just ask for needs its own
  affordance.
- **Recording regenerate spend.** Only `scrape_runs` has a cost ledger. The
  preview cost is displayed in the dialog and dropped.
- **Showing the prompt-guard verdict** in the dialog. `promptGuard` is not part
  of `AdminArticle`, and surfacing it is a §6.2 question, not this one.
- **The judge reading only age 5.** `autoApprove.ts:76` judges
  `story.versions[0]` and publishes all ten, so ages 6–14 publish unjudged.
  Same family of bug as this one, separately deferred.
- **Row actions are not lock-guarded.** Under §2.2's one-process/one-admin
  premise, an Edit made in another tab while a preview is running is
  snapshotted away: the preview's `current` predates the edit, so that age is
  neither badged nor unticked in the dialog, and applying it discards the
  edit the other tab just made.
