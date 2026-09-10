# Story-scoped Regenerate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Regenerate rebuild every age version of a story as one background job, and let the editor apply the ages they tick from a tabbed per-age diff.

**Architecture:** A new `regenerateStory` service runs `simplifyArticleForAllAges` over the story's original raw article, holds the result in module-level job state (the shape `simplifyService` already uses), and writes only the ticked ages from that held preview — so applying never re-runs the model. The admin queue starts the job, polls for progress, and opens a rewritten `RegenerateDialog` with one tab per age.

**Tech Stack:** TypeScript (ESM, NodeNext), Express 5, better-sqlite3, Vitest, React 18 + Vite, Testing Library, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-10-story-scoped-regenerate-design.md` — read it before Task 1; the plan argues from it.

## Global Constraints

- **Ages come from the story, never from `ALL_AGES`.** A pre-phase-1 story has one version; regenerate refreshes what exists and never invents an age.
- **Apply writes the previewed content.** No step may re-run the pipeline on apply. This is a defect being fixed, not a style preference: today's `POST /articles/:id/regenerate/apply` re-runs it, doubling spend and applying text the editor never saw.
- **One job at a time, process-wide.** Every job goes through `acquireJob` / `releaseJob`, with the release in a `finally`. A leaked lock blocks every later scrape and batch.
- **Nothing auto-publishes and nothing is written without a diff first** (§2.2). Preview writes zero rows.
- **Human-edited versions arrive unticked**, badged `✎`, and are only overwritten if the editor ticks them.
- **`editedByHuman` stays per-version.** Applying clears it only on the ages written.
- **Comment style:** files and non-obvious decisions carry a comment saying *why*, citing PRD sections (`§4.2`, `§5`, `§6.2`, `§9.2`) as the surrounding code does.
- **Error vocabulary:** throw `BadRequestError` (400), `NotFoundError` (404), `ConflictError` (409) from `core/errors.js`. Never hand-roll a status code.
- **Verification commands:** `cd server && npm test && npm run typecheck`, `cd web && npm test && npm run typecheck`.

---

### Task 1: Per-age options on `simplifyArticleForAllAges`

The all-ages loop hardcodes `ALL_AGES` and passes one `options` object to every age, so `options.id` would collide — all ten generated versions would claim the same row id. A regeneration needs each age pinned to its stored row, needs to build only the ages a story has, and needs progress. Extend the existing loop rather than writing a second one: this is the only place that knows "one call per age, one shared §6.2 guard call, fallbacks prefixed by age".

**Files:**
- Modify: `server/src/pipeline/simplifyArticle.ts:209-278` (the `AllAgesOutcome` interface and `simplifyArticleForAllAges`)
- Test: `server/tests/llm.test.ts` (inside the existing `describe('simplifyArticleForAllAges')`, which already has `scriptedClient` and `reply` helpers)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AllAgesOptions` with `ages?: number[]`, `perAge?: (ageTarget: number) => { id?: string; now?: string } | undefined`, `onProgress?: (done: number) => void`, extending `Omit<SimplifyOptions, 'ageTarget' | 'promptGuard'>`. `simplifyArticleForAllAges(db, raw, options?: AllAgesOptions)` keeps returning `Promise<AllAgesOutcome>`.

- [ ] **Step 1: Write the failing tests**

Add these three tests at the end of the existing `describe('simplifyArticleForAllAges', ...)` block in `server/tests/llm.test.ts`, before its closing `});`:

```ts
  it('builds only the ages it is given', async () => {
    const { client } = scriptedClient(() => ({ ok: true, body: reply('A kid headline') }));

    const outcome = await simplifyArticleForAllAges(ctx.db, RAW_INPUT, { client, ages: [8] });

    expect(outcome.versions).toHaveLength(1);
    expect(outcome.versions[0].article.ageTarget).toBe(8);
  });

  it('pins each age to the id and createdAt its caller supplies', async () => {
    // A regeneration rewrites STORED rows, so the generated version has to
    // carry the row's identity rather than a fresh uuid.
    const { client } = scriptedClient(() => ({ ok: true, body: reply('A kid headline') }));

    const outcome = await simplifyArticleForAllAges(ctx.db, RAW_INPUT, {
      client,
      ages: [5, 6],
      perAge: (age) => ({ id: `v${age}`, now: `2026-09-0${age}T09:00:00.000Z` }),
    });

    expect(outcome.versions.map((v) => v.article.id)).toEqual(['v5', 'v6']);
    expect(outcome.versions.map((v) => v.article.createdAt)).toEqual([
      '2026-09-05T09:00:00.000Z', '2026-09-06T09:00:00.000Z',
    ]);
  });

  it('reports progress once per age, counting up', async () => {
    const { client } = scriptedClient(() => ({ ok: true, body: reply('A kid headline') }));
    const seen: number[] = [];

    await simplifyArticleForAllAges(ctx.db, RAW_INPUT, {
      client, ages: [5, 6, 7], onProgress: (done) => seen.push(done),
    });

    expect(seen).toEqual([1, 2, 3]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/llm.test.ts -t 'simplifyArticleForAllAges'`
Expected: FAIL — TypeScript rejects `ages`, `perAge` and `onProgress` as unknown properties on the options object.

- [ ] **Step 3: Add the options type**

In `server/src/pipeline/simplifyArticle.ts`, immediately after the `AllAgesOutcome` interface (currently ending at line 218), add:

```ts
/**
 * The all-ages options, on top of everything one age already takes.
 *
 * `perAge` exists because a REGENERATION rewrites stored rows: each age has to
 * be built with the id and createdAt of the row it will replace, or ten
 * versions would either collide on one id or arrive as ten strangers.
 */
export interface AllAgesOptions extends Omit<SimplifyOptions, 'ageTarget' | 'promptGuard'> {
  /** Which ages to build, ascending. Defaults to every age (§3.6). */
  ages?: number[];
  /** Per-age identity, so a regeneration writes back to the stored rows. */
  perAge?: (ageTarget: number) => { id?: string; now?: string } | undefined;
  /** Called with the number of ages attempted so far, for progress polling. */
  onProgress?: (done: number) => void;
}
```

- [ ] **Step 4: Use the options in the loop**

In the same file, change the signature (currently `options: Omit<SimplifyOptions, 'ageTarget' | 'promptGuard'> = {}`) to:

```ts
export async function simplifyArticleForAllAges(
  db: Database,
  raw: RawArticleInput,
  options: AllAgesOptions = {},
): Promise<AllAgesOutcome> {
  const settings = createSettingsRepository(db);
  const guardConfig = settings.getGuardConfig();
  const { ages = ALL_AGES, perAge, onProgress, ...perCall } = options;
```

Replace `age: MIN_AGE` in the `runPromptGuard` context with `age: ages[0]` and update its comment — for the ingest path `ages[0]` *is* `MIN_AGE`, and for a regeneration it is honest about the youngest age actually being built:

```ts
  // Shared across every age. Uses the youngest age being built purely to
  // render the guard prompt's {{age}} variable; the verdict is about the
  // source text, which does not vary by age.
```

Then replace the loop (currently `for (const ageTarget of ALL_AGES) { ... }`) with:

```ts
  let done = 0;
  for (const ageTarget of ages) {
    const outcome = await simplifyArticle(db, raw, {
      ...perCall, ...perAge?.(ageTarget), ageTarget, promptGuard,
    });

    versions.push(outcome);
    costUsd += outcome.costUsd ?? 0;
    // Prefixed with the age: a reviewer needs to know WHICH version is weaker,
    // and with per-age calls a story can be nine parts LLM and one part local.
    if (outcome.fallbackReason) fallbacks.push(`age ${ageTarget}: ${outcome.fallbackReason}`);

    done += 1;
    onProgress?.(done);
  }
```

Leave `MIN_AGE`'s import in place only if still used elsewhere in the file; if TypeScript reports it unused, drop it from the import list.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/llm.test.ts`
Expected: PASS — the three new tests plus every existing one in the file, including `runs the prompt guard once, not once per age` (11 calls) and `falls back only for the age whose call failed`.

- [ ] **Step 6: Run the full server suite and typecheck**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. `simplifyService` still calls the function with no `ages`, so ingest behaviour is unchanged.

- [ ] **Step 7: Commit**

```bash
git add server/src/pipeline/simplifyArticle.ts server/tests/llm.test.ts
git commit -m "feat: let the all-ages pipeline build chosen ages with pinned ids"
```

---

### Task 2: The regenerate job service

The service owns the whole use case: resolve any version's id to its story, run the pipeline over the original raw article for each existing age, hold the preview in memory, and write only the ages an editor ticks. Job-shaped for the reason the manual simplify batch is: ten sequential model calls is minutes, too long for one HTTP request.

**Files:**
- Create: `server/src/services/regenerateStory.ts`
- Modify: `server/src/services/jobLock.ts:16-27` (add the `regenerate` kind)
- Create: `server/tests/regenerate-story.test.ts`

**Interfaces:**
- Consumes: `AllAgesOptions` from Task 1 (`ages`, `perAge`, `onProgress`); `createArticleRepository(db)` with `findStoryState(id)`, `findStory(originalId)`, `applyRegeneration(id, content)`; `createRawArticleRepository(db).findById(id)`; `acquireJob('regenerate')` / `releaseJob()`.
- Produces: `RegeneratedVersion`, `RegenerateJobState`, `RegenerateOptions`, `startRegenerateJob(db, id, options?)`, `getRegenerateJob()`, `resetRegenerateJob()`, `applyRegeneratedVersions(db, jobId, ages)` returning `AdminStory`.

- [ ] **Step 1: Write the failing lock test**

In `server/src/services/jobLock.ts` nothing changes yet. Add to `server/tests/simplify-service.test.ts`, inside `describe('jobLock', ...)`:

```ts
  it('refuses a simplification batch while a regeneration is running', () => {
    acquireJob('regenerate');
    expect(() => acquireJob('simplify')).toThrow(/regeneration is already running/);
  });

  it('refuses a regeneration while a scrape is running', () => {
    acquireJob('scrape');
    expect(() => acquireJob('regenerate')).toThrow(/scrape is already running/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/simplify-service.test.ts -t jobLock`
Expected: FAIL — `'regenerate'` is not assignable to `JobKind`.

- [ ] **Step 3: Add the job kind**

In `server/src/services/jobLock.ts`:

```ts
export type JobKind = 'scrape' | 'simplify' | 'regenerate';

const HOLDER: Record<JobKind, string> = {
  scrape: 'A scrape is already running',
  simplify: 'A simplification batch is already running',
  regenerate: 'A regeneration is already running',
};

const WANTED: Record<JobKind, string> = {
  scrape: 'starting another scrape',
  simplify: 'simplifying more articles',
  regenerate: 'regenerating a story',
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && npx vitest run tests/simplify-service.test.ts -t jobLock`
Expected: PASS.

- [ ] **Step 5: Write the failing service tests**

Create `server/tests/regenerate-story.test.ts`:

```ts
/**
 * Story-scoped regeneration — §4.2 Regenerate, §5 story scope.
 *
 * The rules worth proving are the ones an editor is trusting: a preview writes
 * nothing, apply writes ONLY the ticked ages, and apply never spends another
 * model call — the text applied is the text that was shown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenRouterClient } from '../src/llm/openRouterClient.js';
import { activeJob, acquireJob, releaseJob } from '../src/services/jobLock.js';
import {
  applyRegeneratedVersions, getRegenerateJob, resetRegenerateJob, startRegenerateJob,
  type RegenerateJobState, type RegenerateOptions,
} from '../src/services/regenerateStory.js';
import {
  createTestContext, getKidArticle, insertKidArticle, insertRawArticle, type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); resetRegenerateJob(); });
afterEach(() => { ctx.close(); resetRegenerateJob(); });

const KID_REPLY = JSON.stringify({
  kidHeadline: 'A robot looked at a reef', summary: 'A robot explored a reef.',
  whatHappened: 'It went down deep.', whyItMatters: 'Reefs matter.',
  thinkAbout: 'What lives on a reef?', safety: 'calm', readingMinutes: 2,
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
});

/** A client that answers every completion the same way, and counts them. */
function countingClient(reply = KID_REPLY) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: reply } }],
        usage: { total_tokens: 10, cost: 0.00002 },
      }),
    };
  }) as unknown as typeof fetch;

  return {
    client: new OpenRouterClient({ apiKey: 'test-key', fetchImpl, maxRetries: 1 }),
    calls: () => calls,
  };
}

/** A story with `ages` versions, all pending_review, ids `<rawId>-v<age>`. */
function seedStory(rawId: string, ages = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
  insertRawArticle(ctx.db, {
    id: rawId,
    headline: 'Council approves reef plan',
    body: 'A rover surveyed the reef today. Officials agreed a treaty.',
    url: `https://example.com/${rawId}`,
    sourceUrl: 'https://feeds.bbci.co.uk/news/rss.xml',
    simplifiedAt: '2026-09-06T09:00:00.000Z',
  });
  for (const age of ages) {
    insertKidArticle(ctx.db, {
      id: `${rawId}-v${age}`, originalId: rawId, ageTarget: age,
      kidHeadline: `Stored headline for age ${age}`,
      sourceUrl: `https://example.com/${rawId}`,
    });
  }
  return `${rawId}-v${ages[0]}`;
}

/** Starts the job and resolves with its finished state. */
const runJob = (id: string, options: RegenerateOptions = {}) =>
  new Promise<RegenerateJobState>((resolve) => {
    startRegenerateJob(ctx.db, id, { ...options, onFinished: resolve });
  });

const rowsOf = (rawId: string) =>
  ctx.db.prepare('SELECT * FROM kid_articles WHERE originalId = ? ORDER BY ageTarget')
    .all(rawId) as Record<string, unknown>[];

describe('startRegenerateJob', () => {
  it('previews every age of the story and writes nothing', async () => {
    const anyVersion = seedStory('r1');
    const before = JSON.stringify(rowsOf('r1'));
    const { client } = countingClient();

    const job = await runJob(anyVersion, { client });

    expect(job.ages).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(job.versions).toHaveLength(10);
    expect(job.running).toBe(false);
    expect(job.error).toBeUndefined();
    expect(JSON.stringify(rowsOf('r1'))).toBe(before);
  });

  it('resolves any version id to the whole story', async () => {
    seedStory('r1');
    const { client } = countingClient();

    const job = await runJob('r1-v11', { client });

    expect(job.originalId).toBe('r1');
    expect(job.versions).toHaveLength(10);
  });

  it('pins each generated version to its stored row id and createdAt', async () => {
    seedStory('r1');
    const { client } = countingClient();

    const job = await runJob('r1-v5', { client });

    for (const version of job.versions) {
      expect(version.generated.id).toBe(`r1-v${version.ageTarget}`);
      expect(version.generated.createdAt).toBe(version.current.createdAt);
    }
  });

  it('runs the §6.2 prompt guard once for the story, not once per age', async () => {
    ctx.db.prepare(
      `UPDATE guard_config SET promptGuardEnabled = 1, promptGuardText = 'Classify: {{body}}'
       WHERE id = 'default'`,
    ).run();
    seedStory('r1');
    const { client, calls } = countingClient();

    await runJob('r1-v5', { client });

    // One guard call + ten simplifications. Eleven, not twenty.
    expect(calls()).toBe(11);
  });

  it('regenerates exactly the ages a one-version story has', async () => {
    const only = seedStory('r1', [8]);
    const { client } = countingClient();

    const job = await runJob(only, { client });

    expect(job.ages).toEqual([8]);
    expect(job.versions.map((v) => v.ageTarget)).toEqual([8]);
  });

  it('carries lifecycle fields over so the diff shows only content', async () => {
    seedStory('r1', [5]);
    ctx.db.prepare(
      `UPDATE kid_articles SET status = 'published', publishedAt = '2026-09-07T09:00:00.000Z',
              approvedBy = 'auto', editedByHuman = 1 WHERE id = 'r1-v5'`,
    ).run();
    const { client } = countingClient();

    const job = await runJob('r1-v5', { client });
    const [version] = job.versions;

    expect(version.generated.status).toBe('published');
    expect(version.generated.publishedAt).toBe('2026-09-07T09:00:00.000Z');
    expect(version.generated.approvedBy).toBe('auto');
    // The regenerated text is machine-made, so the flag no longer holds.
    expect(version.generated.editedByHuman).toBe(false);
    // …but the editor still has to be told the stored row was hand-edited.
    expect(version.current.editedByHuman).toBe(true);
  });

  it('keeps the original article link rather than the feed URL', async () => {
    // raw.sourceUrl is the rss.xml; raw.url is the story. Regenerating must not
    // replace a working "Read the original" link with a link to raw XML.
    seedStory('r1', [5]);
    const { client } = countingClient();

    const job = await runJob('r1-v5', { client });

    expect(job.versions[0].generated.sourceUrl).toBe('https://example.com/r1');
  });

  it('holds the lock while it runs and releases it afterwards', async () => {
    seedStory('r1', [5, 6]);
    const { client } = countingClient();

    const started = startRegenerateJob(ctx.db, 'r1-v5', { client });
    expect(started.running).toBe(true);
    expect(activeJob()).toBe('regenerate');

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!getRegenerateJob()?.running) { clearInterval(timer); resolve(); }
      }, 5);
    });
    expect(activeJob()).toBeNull();
  });

  it('refuses to start while another job holds the lock', () => {
    seedStory('r1', [5]);
    acquireJob('scrape');
    expect(() => startRegenerateJob(ctx.db, 'r1-v5')).toThrow(/scrape is already running/);
    releaseJob();
  });

  it('rejects an id that belongs to no story', () => {
    expect(() => startRegenerateJob(ctx.db, 'nope')).toThrow(/No article with id 'nope'/);
    expect(activeJob()).toBeNull();
  });

  it('rejects a story whose raw article has gone, without taking the lock', async () => {
    seedStory('r1', [5]);
    // The raw article is the pipeline's input, and it is read BEFORE the lock
    // is taken, so a story with no source cannot block a scrape.
    ctx.db.prepare('DELETE FROM raw_articles WHERE id = ?').run('r1');

    expect(() => startRegenerateJob(ctx.db, 'r1-v5')).toThrow(/No raw article with id 'r1'/);
    expect(activeJob()).toBeNull();
  });

  it('records a failure thrown INSIDE the job and lets the lock go', async () => {
    seedStory('r1', [5]);
    // guard_config is read inside the job rather than before it, so dropping
    // the table fails the job itself — the only path where job.error is how an
    // editor hears about it. A single weak age is a fallbackReason, not this.
    ctx.db.prepare('DROP TABLE guard_config').run();

    const job = await runJob('r1-v5');

    expect(job.error).toMatch(/guard_config/);
    expect(job.running).toBe(false);
    expect(job.versions).toEqual([]);
    expect(activeJob()).toBeNull();
  });
});

describe('applyRegeneratedVersions', () => {
  it('writes only the ticked ages and leaves the rest alone', async () => {
    seedStory('r1', [5, 6, 7]);
    const { client } = countingClient();
    const job = await runJob('r1-v5', { client });

    applyRegeneratedVersions(ctx.db, job.id, [5, 7]);

    expect(getKidArticle(ctx.db, 'r1-v5')!.kidHeadline).toBe('A robot looked at a reef');
    expect(getKidArticle(ctx.db, 'r1-v7')!.kidHeadline).toBe('A robot looked at a reef');
    expect(getKidArticle(ctx.db, 'r1-v6')!.kidHeadline).toBe('Stored headline for age 6');
  });

  it('clears editedByHuman only on the ages it writes', async () => {
    seedStory('r1', [5, 6]);
    ctx.db.prepare(`UPDATE kid_articles SET editedByHuman = 1 WHERE originalId = 'r1'`).run();
    const { client } = countingClient();
    const job = await runJob('r1-v5', { client });

    applyRegeneratedVersions(ctx.db, job.id, [5]);

    expect(getKidArticle(ctx.db, 'r1-v5')!.editedByHuman).toBe(0);
    expect(getKidArticle(ctx.db, 'r1-v6')!.editedByHuman).toBe(1);
  });

  it('preserves status, publishedAt and approvedBy', async () => {
    seedStory('r1', [5]);
    ctx.db.prepare(
      `UPDATE kid_articles SET status = 'published', publishedAt = '2026-09-07T09:00:00.000Z',
              approvedBy = 'auto' WHERE id = 'r1-v5'`,
    ).run();
    const { client } = countingClient();
    const job = await runJob('r1-v5', { client });

    applyRegeneratedVersions(ctx.db, job.id, [5]);

    expect(getKidArticle(ctx.db, 'r1-v5')).toMatchObject({
      status: 'published', publishedAt: '2026-09-07T09:00:00.000Z', approvedBy: 'auto',
    });
  });

  it('spends no further model calls — the applied text is the shown text', async () => {
    seedStory('r1', [5, 6]);
    const { client, calls } = countingClient();
    const job = await runJob('r1-v5', { client });
    const spent = calls();

    applyRegeneratedVersions(ctx.db, job.id, [5, 6]);

    expect(calls()).toBe(spent);
  });

  it('returns the refreshed story', async () => {
    seedStory('r1', [5, 6]);
    const { client } = countingClient();
    const job = await runJob('r1-v5', { client });

    const story = applyRegeneratedVersions(ctx.db, job.id, [5]);

    expect(story.originalId).toBe('r1');
    expect(story.versions).toHaveLength(2);
    expect(story.versions[0].kidHeadline).toBe('A robot looked at a reef');
  });

  it('refuses a jobId that is not the current preview', async () => {
    seedStory('r1', [5]);
    const { client } = countingClient();
    const job = await runJob('r1-v5', { client });

    expect(() => applyRegeneratedVersions(ctx.db, `${job.id}-stale`, [5]))
      .toThrow(/no longer the current one/);
  });

  it('refuses to apply a job that is still running', () => {
    seedStory('r1', [5, 6]);
    const { client } = countingClient();
    const job = startRegenerateJob(ctx.db, 'r1-v5', { client });

    expect(() => applyRegeneratedVersions(ctx.db, job.id, [5])).toThrow(/still running/);
  });

  it('rejects an empty tick list and an age the preview does not hold', async () => {
    seedStory('r1', [5, 6]);
    const { client } = countingClient();
    const job = await runJob('r1-v5', { client });

    expect(() => applyRegeneratedVersions(ctx.db, job.id, [])).toThrow(/nothing to apply/);
    expect(() => applyRegeneratedVersions(ctx.db, job.id, [12])).toThrow(/does not include age 12/);
  });

  it('reports a story deleted while the dialog was open', async () => {
    seedStory('r1', [5]);
    const { client } = countingClient();
    const job = await runJob('r1-v5', { client });
    ctx.db.prepare('DELETE FROM kid_articles WHERE originalId = ?').run('r1');

    expect(() => applyRegeneratedVersions(ctx.db, job.id, [5])).toThrow(/No article with id 'r1'/);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd server && npx vitest run tests/regenerate-story.test.ts`
Expected: FAIL — cannot resolve `../src/services/regenerateStory.js`.

- [ ] **Step 7: Write the service**

Create `server/src/services/regenerateStory.ts`:

```ts
/**
 * Story-scoped regeneration — §4.2 "Regenerate", under §5's story scope.
 *
 * Re-runs the pipeline over the ORIGINAL raw article for every age version a
 * story has, holds the result in memory, and writes only the ages an editor
 * ticks. Preview and apply are separate because §2.2 promises a person reads
 * what a child will: nothing here writes a row the editor has not seen.
 *
 * Job-shaped for the same reason the manual simplify batch is: ten versions is
 * ten sequential model calls, which is minutes — far too long to hold an HTTP
 * request open. The client polls instead.
 *
 * Apply reuses the HELD preview rather than re-running the pipeline. Re-running
 * would bill a second set of calls and, the model being non-deterministic,
 * could write text the editor never saw in the diff.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { BadRequestError, ConflictError, NotFoundError } from '../core/errors.js';
import {
  createArticleRepository, type AdminArticle, type AdminStory,
} from '../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import { simplifyArticleForAllAges } from '../pipeline/simplifyArticle.js';
import { acquireJob, releaseJob } from './jobLock.js';

export interface RegeneratedVersion {
  ageTarget: number;
  /** The stored row this age would replace. */
  current: AdminArticle;
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
  /** The story's existing versions, ascending. Never ALL_AGES by assumption. */
  ages: number[];
  /** Ages attempted so far, for "Regenerating… 4/10". */
  done: number;
  running: boolean;
  versions: RegeneratedVersion[];
  /** Spent whether or not the editor applies. */
  costUsd: number;
  /** A thrown failure. A single weak age is a fallbackReason, not this. */
  error?: string;
  /** Set once applied, so the client stops offering apply. */
  appliedAges?: number[];
}

export interface RegenerateOptions {
  /** Test and sandbox seam; without one, simplifyArticle reads LLM_ENABLED. */
  client?: OpenRouterClient;
  now?: () => string;
}

/** Module-level for the same reason as the job lock: one process, one admin. */
let current: RegenerateJobState | null = null;

export function getRegenerateJob(): RegenerateJobState | null {
  return current;
}

/** Test seam, and the Discard button: forget the preview, let go of the lock. */
export function resetRegenerateJob(): void {
  current = null;
  releaseJob();
}

/**
 * Begin a preview for the story `id` belongs to and return immediately.
 *
 * `id` may be ANY version's id, as it may for publish and reject (§5): an
 * editor acts on a story, and the queue happens to hold ten rows for it.
 */
export function startRegenerateJob(
  db: Database,
  id: string,
  options: RegenerateOptions & { onFinished?: (state: RegenerateJobState) => void } = {},
): RegenerateJobState {
  const articles = createArticleRepository(db);
  const rawArticles = createRawArticleRepository(db);
  const clock = options.now ?? (() => new Date().toISOString());

  const state = articles.findStoryState(id);
  if (!state) throw NotFoundError.of('article', id);

  const story = articles.findStory(state.originalId);
  if (!story) throw NotFoundError.of('article', id);

  const raw = rawArticles.findById(story.originalId);
  if (!raw) throw NotFoundError.of('raw article', story.originalId);

  // After every 404, so a bad request cannot take the lock and block a scrape.
  acquireJob('regenerate');

  const byAge = new Map(story.versions.map((version) => [version.ageTarget, version]));
  const job: RegenerateJobState = {
    id: randomUUID(),
    originalId: story.originalId,
    kidHeadline: story.kidHeadline,
    startedAt: clock(),
    ages: story.versions.map((version) => version.ageTarget),
    done: 0,
    running: true,
    versions: [],
    costUsd: 0,
  };
  current = job;

  // Deliberately not awaited: the caller gets the state back straight away.
  void (async () => {
    try {
      const outcome = await simplifyArticleForAllAges(
        db,
        {
          id: raw.id,
          headline: raw.headline,
          body: raw.body,
          topic: raw.topic,
          sourceName: raw.sourceName,
          // The article, not the feed it came from — see simplifyService.
          sourceUrl: raw.url,
        },
        {
          client: options.client,
          ages: job.ages,
          // Each age is built as the row it will replace, so the diff and the
          // update both address the version the editor is looking at.
          perAge: (age) => {
            const stored = byAge.get(age);
            return stored ? { id: stored.id, now: stored.createdAt } : undefined;
          },
          onProgress: (done) => { job.done = done; },
        },
      );

      job.costUsd = outcome.costUsd;
      job.versions = outcome.versions.map((version) => {
        // Non-null: perAge built this age from exactly this map.
        const stored = byAge.get(version.article.ageTarget)!;
        return {
          ageTarget: stored.ageTarget,
          current: stored,
          engine: version.engine,
          model: version.model,
          fallbackReason: version.fallbackReason,
          // Identity and lifecycle fields are carried over, so the diff shows
          // only what regeneration would actually change.
          generated: {
            ...version.article,
            status: stored.status,
            publishedAt: stored.publishedAt,
            rejectReason: stored.rejectReason,
            editedByHuman: false,
            sourceId: stored.sourceId,
            originalHeadline: stored.originalHeadline,
            // Regenerating text does not change who approved the story.
            approvedBy: stored.approvedBy,
          },
        };
      });
    } catch (error: unknown) {
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      // Always: a leaked lock would block every later scrape and batch.
      job.running = false;
      job.finishedAt = clock();
      releaseJob();
      options.onFinished?.(job);
    }
  })();

  return job;
}

/**
 * Write the ticked ages from the held preview.
 *
 * One transaction for every age: a story left holding a mix of chosen and
 * unchosen rewrites is not something an editor could reason about.
 */
export function applyRegeneratedVersions(
  db: Database,
  jobId: string,
  ages: number[],
): AdminStory {
  const job = current;
  if (!job || job.id !== jobId) {
    throw new ConflictError('That preview is no longer the current one. Regenerate the story again.');
  }
  if (job.running) {
    throw new ConflictError('That regeneration is still running. Wait for it to finish.');
  }
  if (ages.length === 0) {
    throw new BadRequestError('No versions were ticked, so there is nothing to apply.');
  }

  const byAge = new Map(job.versions.map((version) => [version.ageTarget, version]));
  const chosen = ages.map((age) => {
    const version = byAge.get(age);
    if (!version) throw new BadRequestError(`This preview does not include age ${age}.`);
    return version;
  });

  const articles = createArticleRepository(db);
  db.transaction(() => {
    for (const version of chosen) {
      articles.applyRegeneration(version.generated.id, version.generated);
    }
  })();

  job.appliedAges = [...ages];

  // A story deleted while the dialog was open updates nothing, so saying so
  // afterwards costs nothing and tells the editor the truth.
  const story = articles.findStory(job.originalId);
  if (!story) throw NotFoundError.of('article', job.originalId);
  return story;
}
```

- [ ] **Step 8: Run the service tests to verify they pass**

Run: `cd server && npx vitest run tests/regenerate-story.test.ts`
Expected: PASS — all of `startRegenerateJob` and `applyRegeneratedVersions`.

- [ ] **Step 9: Run the full server suite and typecheck**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. `regenerateArticle.ts` still exists and is still used by the old routes; nothing has been removed yet.

- [ ] **Step 10: Commit**

```bash
git add server/src/services/regenerateStory.ts server/src/services/jobLock.ts \
        server/tests/regenerate-story.test.ts server/tests/simplify-service.test.ts
git commit -m "feat: add a story-scoped regenerate job holding its preview"
```

---

### Task 3: Story-scoped regenerate routes

Replace the two per-version endpoints with four: start, status, apply, discard. The old service file goes with them.

**Files:**
- Modify: `server/src/routes/admin/articleActions.ts:1-120` (module comment, imports, the two regenerate handlers)
- Delete: `server/src/services/regenerateArticle.ts`
- Modify: `server/tests/admin-actions.test.ts:89-135` (delete the whole `describe('regenerate (§4.2)')` block — its assertions now live in `regenerate-story.test.ts`)
- Modify: `server/tests/regenerate-story.test.ts` (add an HTTP-level describe)

**Interfaces:**
- Consumes: `startRegenerateJob`, `getRegenerateJob`, `resetRegenerateJob`, `applyRegeneratedVersions` from Task 2; `requireInt` and `requireString` from `http/validation.js`; `MIN_AGE`, `MAX_AGE` from `core/article.js`.
- Produces: `POST /api/admin/articles/:id/regenerate` → `202 { running, job }`; `GET /api/admin/articles/regenerate/status` → `{ running, job }`; `POST /api/admin/articles/regenerate/apply` with `{ jobId, ages }` → `AdminStory`; `DELETE /api/admin/articles/regenerate` → `{ discarded: true }`.

- [ ] **Step 1: Write the failing route tests**

Append to `server/tests/regenerate-story.test.ts`:

```ts
describe('the regenerate endpoints (§4.2)', () => {
  /** Waits for the background job to finish, then returns the status body. */
  const awaitJob = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const body = await (await ctx.api('/api/admin/articles/regenerate/status')).json();
      if (!body.running) return body as { running: boolean; job: RegenerateJobState | null };
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    throw new Error('The regenerate job never finished.');
  };

  it('starts a preview for the whole story and writes nothing', async () => {
    seedStory('r1', [5, 6, 7]);
    const before = JSON.stringify(rowsOf('r1'));

    const started = await ctx.api('/api/admin/articles/r1-v6/regenerate', { method: 'POST' });
    expect(started.status).toBe(202);
    expect((await started.json()).job.ages).toEqual([5, 6, 7]);

    const { job } = await awaitJob();
    expect(job?.versions).toHaveLength(3);
    expect(JSON.stringify(rowsOf('r1'))).toBe(before);
  });

  it('404s for an id that belongs to no story', async () => {
    const res = await ctx.api('/api/admin/articles/nope/regenerate', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s while another job holds the lock', async () => {
    seedStory('r1', [5]);
    acquireJob('scrape');
    const res = await ctx.api('/api/admin/articles/r1-v5/regenerate', { method: 'POST' });
    expect(res.status).toBe(409);
    releaseJob();
  });

  it('applies only the ticked ages and returns the refreshed story', async () => {
    seedStory('r1', [5, 6]);
    await ctx.api('/api/admin/articles/r1-v5/regenerate', { method: 'POST' });
    const { job } = await awaitJob();

    const res = await ctx.api('/api/admin/articles/regenerate/apply', {
      method: 'POST', body: JSON.stringify({ jobId: job!.id, ages: [6] }),
    });

    expect(res.status).toBe(200);
    const story = await res.json();
    expect(story.originalId).toBe('r1');
    expect(getKidArticle(ctx.db, 'r1-v5')!.kidHeadline).toBe('Stored headline for age 5');
    expect(getKidArticle(ctx.db, 'r1-v6')!.kidHeadline).not.toBe('Stored headline for age 6');
  });

  it('400s on a missing jobId, an empty tick list, or an unpreviewed age', async () => {
    seedStory('r1', [5]);
    await ctx.api('/api/admin/articles/r1-v5/regenerate', { method: 'POST' });
    const { job } = await awaitJob();

    const apply = (body: unknown) =>
      ctx.api('/api/admin/articles/regenerate/apply', { method: 'POST', body: JSON.stringify(body) });

    expect((await apply({ ages: [5] })).status).toBe(400);
    expect((await apply({ jobId: job!.id, ages: [] })).status).toBe(400);
    expect((await apply({ jobId: job!.id, ages: ['five'] })).status).toBe(400);
    expect((await apply({ jobId: job!.id, ages: [99] })).status).toBe(400);
  });

  it('409s when the jobId is stale', async () => {
    seedStory('r1', [5]);
    await ctx.api('/api/admin/articles/r1-v5/regenerate', { method: 'POST' });
    const { job } = await awaitJob();

    const res = await ctx.api('/api/admin/articles/regenerate/apply', {
      method: 'POST', body: JSON.stringify({ jobId: `${job!.id}-stale`, ages: [5] }),
    });
    expect(res.status).toBe(409);
  });

  it('discards the held preview without touching the story', async () => {
    // DELETE /articles/regenerate must not be read as deleting the story
    // whose id happens to be "regenerate": the discard route is registered
    // BEFORE DELETE /articles/:id for exactly that reason.
    seedStory('r1', [5]);
    await ctx.api('/api/admin/articles/r1-v5/regenerate', { method: 'POST' });
    await awaitJob();

    const res = await ctx.api('/api/admin/articles/regenerate', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(getRegenerateJob()).toBeNull();
    expect(rowsOf('r1')).toHaveLength(1);
  });

  it('no longer offers the per-version endpoints', async () => {
    seedStory('r1', [5]);
    const res = await ctx.api('/api/admin/articles/r1-v5/regenerate/apply', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run tests/regenerate-story.test.ts -t 'regenerate endpoints'`
Expected: FAIL — the status endpoint 404s and the start endpoint returns the old preview body with status 200.

- [ ] **Step 3: Delete the superseded test block**

In `server/tests/admin-actions.test.ts`, delete the entire `describe('regenerate (§4.2)', ...)` block (lines 89-135, from `describe('regenerate (§4.2)'` through its closing `});`). Its four behaviours — preview writes nothing, apply clears `editedByHuman`, apply preserves status and `publishedAt`, and the `raw.url` source link — are covered in `regenerate-story.test.ts`.

- [ ] **Step 4: Rewrite the route handlers**

In `server/src/routes/admin/articleActions.ts`, replace the module comment's SCOPE paragraph:

```ts
/**
 * Row actions on one story: publish / reject / re-review / edit / regenerate /
 * delete (§4.2).
 *
 * SCOPE (§5): a story is one raw article's ten age versions (§3.6), and an
 * editor approves the story. So publish, reject, unpublish, delete and
 * regenerate take any one version's id and apply to EVERY version of that
 * story. The URLs are unchanged from when a story had one version; the scope
 * is not.
 *
 * Edit is the exception and stays per-version, so one age's wording can be
 * fixed without touching the other nine. Regenerate previews every age but
 * applies only the ones an editor ticks, which is the same idea from the other
 * end: the machine offers all ten, the person chooses.
 */
```

Swap the import of the deleted service for the new one:

```ts
import { MAX_AGE, MIN_AGE } from '../../core/article.js';
import {
  applyRegeneratedVersions, getRegenerateJob, resetRegenerateJob, startRegenerateJob,
} from '../../services/regenerateStory.js';
```

Add, next to `readContentChanges`:

```ts
/** The ticked ages an apply request carries. */
function readAges(body: Record<string, unknown>): number[] {
  const { ages } = body;
  if (!Array.isArray(ages) || ages.length === 0) {
    throw new BadRequestError('ages must be a non-empty array of reading ages.');
  }
  return ages.map((age, index) => requireInt(age, `ages[${index}]`, { min: MIN_AGE, max: MAX_AGE }));
}
```

Inside `createArticleActionsRouter`, add beside `respond`:

```ts
  /** The same envelope the simplify batch reports, for the same poller. */
  const jobResponse = () => {
    const job = getRegenerateJob();
    return { running: job?.running ?? false, job };
  };
```

Then replace both existing regenerate handlers with these four. **Register them in this order, and keep all four above `router.delete('/articles/:id')`** — otherwise `DELETE /articles/regenerate` is read as deleting a story whose id is `regenerate`:

```ts
  /**
   * §4.2 Regenerate — preview only, and story-scoped (§5).
   *
   * Ten versions is ten sequential model calls, so this returns straight away;
   * poll /articles/regenerate/status.
   */
  router.post('/articles/:id/regenerate', (req, res) => {
    requireStory(req.params.id);
    startRegenerateJob(db, req.params.id);
    res.status(202).json(jobResponse());
  });

  router.get('/articles/regenerate/status', (_req, res) => {
    res.json(jobResponse());
  });

  /** Writes the ticked ages from the held preview. No further model calls. */
  router.post('/articles/regenerate/apply', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const jobId = requireString(body.jobId, 'jobId');
    res.json(applyRegeneratedVersions(db, jobId, readAges(body)));
  });

  /** Discard: the editor closed the dialog, so stop holding the preview. */
  router.delete('/articles/regenerate', (_req, res) => {
    resetRegenerateJob();
    res.json({ discarded: true });
  });
```

`requireArticle` stays — Edit is still per-version and is now its only caller, which is correct rather than dead code.

- [ ] **Step 5: Delete the old service**

```bash
git rm server/src/services/regenerateArticle.ts
```

- [ ] **Step 6: Run the route tests to verify they pass**

Run: `cd server && npx vitest run tests/regenerate-story.test.ts tests/admin-actions.test.ts`
Expected: PASS, including `no longer offers the per-version endpoints`.

- [ ] **Step 7: Run the full server suite and typecheck**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS, with no reference left to `regenerateArticle.js`. If `grep -rn "regenerateArticle" server/src server/tests` prints anything, fix it before committing.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/admin/articleActions.ts server/tests/admin-actions.test.ts \
        server/tests/regenerate-story.test.ts
git commit -m "feat: make the regenerate endpoints story-scoped and job-shaped"
```

---

### Task 4: Client types, `VersionDiff`, and the tabbed dialog

The dialog stops being a two-column diff of one version and becomes a tab per age with a tick box. The field table itself is already the right component — it just has to move out so the dialog can own tabs and ticks.

**Files:**
- Modify: `web/src/admin/types.ts` (add `RegeneratedVersion` and `RegenerateJob` after `SimplifyJob`)
- Create: `web/src/pages/admin/dialogs/VersionDiff.tsx`
- Modify: `web/src/pages/admin/dialogs/RegenerateDialog.tsx` (rewrite)
- Modify: `web/src/pages/admin/dialogs/index.ts` (export `VersionDiff`)
- Modify: `web/src/__tests__/admin-dialogs.test.tsx:121-178` (replace the `RegenerateDialog` describe)

**Interfaces:**
- Consumes: the server's `RegenerateJobState` shape from Task 2, mirrored in TypeScript.
- Produces: `RegenerateJob`, `RegeneratedVersion` types; `VersionDiff({ current, generated })`; `changedFields(current, generated): string[]`; `RegenerateDialog({ job, onDiscard, onApply })` where `onApply` receives the ticked ages ascending.

- [ ] **Step 1: Write the failing dialog tests**

In `web/src/__tests__/admin-dialogs.test.tsx`, replace the whole `describe('RegenerateDialog (§4.2)', ...)` block with:

```tsx
describe('RegenerateDialog (§4.2, story-scoped)', () => {
  const version = (age: number, over: Partial<AdminArticle> = {}, current: Partial<AdminArticle> = {}) => ({
    ageTarget: age,
    current: article({ id: `v${age}`, ageTarget: age, kidHeadline: `Stored age ${age}`, ...current }),
    generated: article({ id: `v${age}`, ageTarget: age, kidHeadline: `Fresh age ${age}`, ...over }),
    engine: 'llm',
  });

  const job = (versions: ReturnType<typeof version>[]): RegenerateJob => ({
    id: 'job-1', originalId: 'r1', kidHeadline: 'A story headline',
    startedAt: '2026-09-10T09:00:00.000Z', finishedAt: '2026-09-10T09:02:00.000Z',
    ages: versions.map((v) => v.ageTarget), done: versions.length, running: false,
    versions, costUsd: 0.0043,
  });

  const open = (state: RegenerateJob) => {
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    render(<RegenerateDialog job={state} onDiscard={onDiscard} onApply={onApply} />);
    return { onApply, onDiscard };
  };

  it('offers one tab per age and opens on the youngest', () => {
    open(job([version(5), version(9), version(14)]));

    for (const age of [5, 9, 14]) {
      expect(screen.getByRole('tab', { name: new RegExp(`Age ${age}`) })).toBeInTheDocument();
    }
    expect(screen.getByText('Fresh age 5')).toBeInTheDocument();
    expect(screen.queryByText('Fresh age 14')).not.toBeInTheDocument();
  });

  it('switches the diff when another age is picked', async () => {
    open(job([version(5), version(14)]));

    await userEvent.click(screen.getByRole('tab', { name: /Age 14/ }));

    expect(screen.getByText('Fresh age 14')).toBeInTheDocument();
    expect(screen.queryByText('Fresh age 5')).not.toBeInTheDocument();
  });

  it('says how many fields would change for the age on screen', () => {
    open(job([version(5, { kidHeadline: 'Fresh age 5', summary: 'New summary.' })]));
    expect(screen.getByText(/2 field\(s\) would change/)).toBeInTheDocument();
  });

  it('says so when an age would not change at all', () => {
    open(job([version(5, { kidHeadline: 'Stored age 5' })]));
    expect(screen.getByText(/no differences/i)).toBeInTheDocument();
  });

  it('ticks every age a person has not edited', () => {
    open(job([version(5), version(6)]));

    expect(screen.getByRole('checkbox', { name: 'Apply age 5' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply 2 of 2 versions' })).toBeEnabled();
  });

  it('leaves a human-edited age unticked and warns about it', async () => {
    open(job([version(5), version(6, {}, { editedByHuman: true })]));

    expect(screen.getByRole('checkbox', { name: 'Apply age 6' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply 1 of 2 versions' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Age 6/ }));
    expect(screen.getByText(/edited by a person/i)).toBeInTheDocument();
  });

  it('applies exactly the ticked ages, ascending', async () => {
    const { onApply } = open(job([version(5), version(6), version(7)]));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Apply age 6' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply 2 of 3 versions' }));

    expect(onApply).toHaveBeenCalledWith([5, 7]);
  });

  it('cannot apply nothing', async () => {
    open(job([version(5)]));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Apply age 5' }));

    expect(screen.getByRole('button', { name: /Apply 0 of 1/ })).toBeDisabled();
  });

  it('unticks and re-ticks every age at once', async () => {
    open(job([version(5), version(6)]));

    await userEvent.click(screen.getByRole('button', { name: 'Untick all' }));
    expect(screen.getByRole('checkbox', { name: 'Apply age 5' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Tick all' }));
    expect(screen.getByRole('checkbox', { name: 'Apply age 5' })).toBeChecked();
  });

  it('names the preview cost, because it is spent either way', () => {
    open(job([version(5)]));
    expect(screen.getByText(/\$0\.0043/)).toBeInTheDocument();
  });

  it('says which ages fell back to the rule-based pipeline', () => {
    const fell = { ...version(5), fallbackReason: 'upstream exploded' };
    open(job([fell]));
    expect(screen.getByText(/rule-based pipeline: upstream exploded/)).toBeInTheDocument();
  });

  it('discards without applying', async () => {
    const { onDiscard, onApply } = open(job([version(5)]));

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onDiscard).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
```

Add `RegenerateJob` to the type import at the top of that file:

```tsx
import type { AdminArticle, AdminStory, RegenerateJob } from '../admin/types';
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/__tests__/admin-dialogs.test.tsx -t RegenerateDialog`
Expected: FAIL — `RegenerateJob` is not exported from `../admin/types`, and `RegenerateDialog` takes no `job` prop.

- [ ] **Step 3: Add the client types**

In `web/src/admin/types.ts`, after the `SimplifyJob` interface:

```ts
/** One age's before/after, as the regenerate preview reports it. */
export interface RegeneratedVersion {
  ageTarget: number;
  /** The stored row this age would replace. */
  current: AdminArticle;
  generated: AdminArticle;
  engine: string;
  model?: string;
  /** Set when this age fell back to the rule-based pipeline (§9.2). */
  fallbackReason?: string;
}

/**
 * A story-scoped regeneration, as the status endpoint reports it (§4.2).
 *
 * `ages` is the story's EXISTING versions, so a pre-per-age story previews one
 * tab rather than pretending to have ten.
 */
export interface RegenerateJob {
  id: string;
  originalId: string;
  kidHeadline: string;
  startedAt: string;
  finishedAt?: string;
  ages: number[];
  /** Ages attempted so far, for the row's progress label. */
  done: number;
  running: boolean;
  versions: RegeneratedVersion[];
  /** Spent whether or not the editor applies. */
  costUsd: number;
  error?: string;
  appliedAges?: number[];
}
```

- [ ] **Step 4: Extract the field table**

Create `web/src/pages/admin/dialogs/VersionDiff.tsx`:

```tsx
import type { AdminArticle } from '../../../admin/types';

/** The kid-facing fields §4.2 lets a regeneration replace. */
export const DIFF_FIELDS = [
  'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'thinkAbout', 'feelingNote', 'safety', 'category', 'readingMinutes',
] as const;

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)';
  return String(value);
}

/** Which fields differ, with vocab counted as one. */
export function changedFields(current: AdminArticle, generated: AdminArticle): string[] {
  const changed: string[] = DIFF_FIELDS.filter(
    (field) => String(current[field] ?? '') !== String(generated[field] ?? ''),
  );
  if (JSON.stringify(current.vocab) !== JSON.stringify(generated.vocab)) changed.push('vocab');
  return changed;
}

/**
 * One age's before/after. Unchanged rows stay on screen at half opacity: an
 * editor deciding whether to take a rewrite needs to see what it leaves alone.
 */
export function VersionDiff({
  current, generated,
}: {
  current: AdminArticle;
  generated: AdminArticle;
}) {
  const changed = changedFields(current, generated);

  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="pb-2 pr-4">Field</th>
            <th className="pb-2 pr-4 w-1/2">Current</th>
            <th className="pb-2 w-1/2">Regenerated</th>
          </tr>
        </thead>
        <tbody>
          {DIFF_FIELDS.map((f) => {
            const isChanged = changed.includes(f);
            return (
              <tr key={f} className={`align-top border-t border-border ${isChanged ? '' : 'opacity-50'}`}>
                <td className="py-2 pr-4 font-bold whitespace-nowrap">{f}</td>
                <td className={`py-2 pr-4 ${isChanged ? 'bg-destructive/10 rounded-lg px-2' : ''}`}>
                  {display(current[f])}
                </td>
                <td className={`py-2 ${isChanged ? 'bg-safety-calm/15 rounded-lg px-2' : ''}`}>
                  {display(generated[f])}
                </td>
              </tr>
            );
          })}
          <tr className={`align-top border-t border-border ${changed.includes('vocab') ? '' : 'opacity-50'}`}>
            <td className="py-2 pr-4 font-bold">vocab</td>
            <td className={`py-2 pr-4 ${changed.includes('vocab') ? 'bg-destructive/10 rounded-lg px-2' : ''}`}>
              {current.vocab.map((v) => v.word).join(', ') || '(none)'}
            </td>
            <td className={`py-2 ${changed.includes('vocab') ? 'bg-safety-calm/15 rounded-lg px-2' : ''}`}>
              {generated.vocab.map((v) => v.word).join(', ') || '(none)'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Rewrite the dialog**

Replace the whole contents of `web/src/pages/admin/dialogs/RegenerateDialog.tsx`:

```tsx
import { useState } from 'react';
import type { RegenerateJob } from '../../../admin/types';
import { Button } from '../../../ui/Button';
import { Modal } from './Modal';
import { changedFields, VersionDiff } from './VersionDiff';

/**
 * §4.2 Regenerate — every age version of one story, a tab each.
 *
 * Regeneration is story-scoped like publish and reject (§5), but APPLYING is
 * per-age: an editor who likes nine rewrites and not the tenth should be able
 * to take the nine. Ages a person has edited arrive unticked, so no human
 * wording is replaced unless someone chooses to replace it.
 */
export function RegenerateDialog({
  job,
  onDiscard,
  onApply,
}: {
  job: RegenerateJob;
  onDiscard: () => void;
  onApply: (ages: number[]) => void;
}) {
  const [active, setActive] = useState(job.versions[0].ageTarget);
  const [ticked, setTicked] = useState<Set<number>>(
    () => new Set(
      job.versions.filter((v) => !v.current.editedByHuman).map((v) => v.ageTarget),
    ),
  );

  const version = job.versions.find((v) => v.ageTarget === active) ?? job.versions[0];
  const changed = changedFields(version.current, version.generated);
  const plural = job.versions.length === 1 ? '' : 's';

  const toggle = (age: number) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(age)) next.delete(age);
      else next.add(age);
      return next;
    });

  return (
    <Modal title="Regenerate — review before applying" onClose={onDiscard} wide>
      <p className="text-sm text-muted-foreground">
        {job.versions.length} version{plural} re-run through the current guard config and
        prompts. Nothing has been saved yet. Preview cost ${job.costUsd.toFixed(4)}.
      </p>

      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Age versions">
          {job.versions.map((v) => {
            const count = changedFields(v.current, v.generated).length;
            const isActive = v.ageTarget === active;
            return (
              <span
                key={v.ageTarget}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-sm whitespace-nowrap ${
                  isActive ? 'border-primary bg-primary/10 font-bold' : 'border-border'
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={`Apply age ${v.ageTarget}`}
                  checked={ticked.has(v.ageTarget)}
                  onChange={() => toggle(v.ageTarget)}
                />
                <button role="tab" aria-selected={isActive} onClick={() => setActive(v.ageTarget)}>
                  Age {v.ageTarget}
                  {v.current.editedByHuman && <span aria-hidden="true"> ✎</span>}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {count === 0 ? '—' : `•${count}`}
                  </span>
                </button>
              </span>
            );
          })}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setTicked(
              ticked.size === 0 ? new Set(job.versions.map((v) => v.ageTarget)) : new Set(),
            )
          }
        >
          {ticked.size === 0 ? 'Tick all' : 'Untick all'}
        </Button>
      </div>

      <p className="mt-4 text-sm font-bold">
        Age {version.ageTarget}
        {version.current.editedByHuman && ' · edited by a person'}
        {' · '}
        {changed.length === 0
          ? 'no differences — applying this age would change nothing'
          : `${changed.length} field(s) would change`}
      </p>

      {version.fallbackReason && (
        <p className="mt-2 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
          This age fell back to the rule-based pipeline: {version.fallbackReason}
        </p>
      )}

      <VersionDiff current={version.current} generated={version.generated} />

      {version.current.editedByHuman && (
        <p className="mt-4 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
          ✎ This age was edited by a person. Tick it only if you want that wording replaced.
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-5">
        <Button variant="ghost" size="lg" onClick={onDiscard}>
          Discard
        </Button>
        <Button
          size="lg"
          disabled={ticked.size === 0}
          onClick={() => onApply([...ticked].sort((a, b) => a - b))}
        >
          Apply {ticked.size} of {job.versions.length} version{plural}
        </Button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 6: Export the new component**

In `web/src/pages/admin/dialogs/index.ts`, add beside the others:

```ts
export { VersionDiff, changedFields, DIFF_FIELDS } from './VersionDiff';
```

- [ ] **Step 7: Run the dialog tests to verify they pass**

Run: `cd web && npx vitest run src/__tests__/admin-dialogs.test.tsx`
Expected: PASS for the whole file. `AdminReview` still passes the old props, so `npm run typecheck` will fail until Task 5 — that is expected and is why this task's gate is the dialog suite, not the typecheck.

- [ ] **Step 8: Commit**

```bash
git add web/src/admin/types.ts web/src/pages/admin/dialogs/VersionDiff.tsx \
        web/src/pages/admin/dialogs/RegenerateDialog.tsx \
        web/src/pages/admin/dialogs/index.ts web/src/__tests__/admin-dialogs.test.tsx
git commit -m "feat: give the regenerate dialog a tab and a tick box per age"
```

---

### Task 5: The queue speaks the new protocol

The row starts a job instead of awaiting a preview, shows progress while it runs, and opens the tabbed dialog when it finishes. Three existing suites mock the old two-endpoint shape and are repaired in the same commit, so the tree is never left red.

**Files:**
- Create: `web/src/pages/admin/review/useRegenerateJob.ts`
- Modify: `web/src/pages/admin/AdminReview.tsx` (imports, remove `regenerating` state and `openRegenerate`, row wiring, dialog render)
- Modify: `web/src/pages/admin/review/StoryRow.tsx` (a `progress` prop on the Regenerate button)
- Create: `web/src/__tests__/admin-regenerate.test.tsx`
- Modify: `web/src/__tests__/admin-review.test.tsx` (drop the old regenerate describe and its mock branch)
- Modify: `web/src/__tests__/admin-ux.test.tsx` (teach the mock the new endpoints)

**Interfaces:**
- Consumes: `RegenerateJob` from Task 4; `RegenerateDialog({ job, onDiscard, onApply })` from Task 4; the four endpoints from Task 3.
- Produces: `useRegenerateJob({ setNotice, onApplied })` returning `{ job, startingId, start, apply, discard }`; `StoryRow`'s optional `progress?: { done: number; total: number } | null`.

- [ ] **Step 1: Write the failing integration tests**

Create `web/src/__tests__/admin-regenerate.test.tsx`:

```tsx
/**
 * Story-scoped Regenerate from the queue — §4.2 under §5's story scope.
 *
 * The job is what makes this different from every other row action: the click
 * starts work that outlives the request, so the row has to say so, and the
 * dialog only appears once every age has been rebuilt.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminReview } from '../pages/admin/AdminReview';
import type { AdminArticle } from '../admin/types';

const BASE: AdminArticle = {
  id: 'v5', originalId: 'r1', ageTarget: 5, kidHeadline: 'Stored age 5',
  summary: 'A summary.', whatHappened: 'What happened.', whyItMatters: 'Why it matters.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'Think?', feelingNote: null, safety: 'calm', contentWarnings: null,
  category: 'Environment', readingMinutes: 3, sourceName: 'BBC News',
  sourceUrl: 'https://example.com/original', status: 'pending_review', rejectReason: null,
  editedByHuman: false, createdAt: '2026-09-08T10:00:00.000Z', publishedAt: null,
  sourceId: 'bbc', originalHeadline: 'Adult headline', approvedBy: null,
};

const versions: AdminArticle[] = [5, 8, 14].map((age) => ({
  ...BASE, id: `v${age}`, ageTarget: age, kidHeadline: `Stored age ${age}`,
}));

let jobRunning = false;
let jobLost = false;
let done = 1;
let startStatus = 202;
let applyBody: { jobId: string; ages: number[] } | null = null;
let discarded = false;

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    const story = {
      originalId: 'r1', versions, safety: 'calm', status: 'pending_review', approvedBy: null,
      kidHeadline: 'Stored age 5', category: 'Environment', sourceId: 'bbc',
      originalHeadline: 'Adult headline', createdAt: '2026-09-08T10:00:00.000Z',
    };

    const job = () => ({
      id: 'job-1', originalId: 'r1', kidHeadline: 'Stored age 5',
      startedAt: '2026-09-10T09:00:00.000Z', ages: [5, 8, 14], done,
      running: jobRunning, costUsd: 0.0043,
      // A running job has attempted some ages but reports versions only when
      // it is done, exactly as the service fills them in at the end.
      versions: jobRunning
        ? []
        : versions.map((v) => ({
            ageTarget: v.ageTarget,
            current: v,
            generated: { ...v, kidHeadline: `Fresh age ${v.ageTarget}` },
            engine: 'llm',
          })),
    });

    if (path.includes('/articles/regenerate/status')) {
      return json({ running: jobRunning, job: jobLost ? null : job() });
    }
    if (path.includes('/articles/regenerate/apply')) {
      applyBody = JSON.parse(String(init.body)) as { jobId: string; ages: number[] };
      return json(story);
    }
    if (path.endsWith('/articles/regenerate') && method === 'DELETE') {
      discarded = true;
      return json({ discarded: true });
    }
    if (path.includes('/regenerate') && method === 'POST') {
      if (startStatus !== 202) {
        return json({ error: 'A scrape is already running. Wait for it to finish before regenerating a story.' }, startStatus);
      }
      jobRunning = true;
      return json({ running: true, job: job() }, 202);
    }
    if (path.includes('/counts')) return json({ pending_review: 1, published: 0, rejected: 0, total: 1, waiting: 0 });
    if (path.includes('/filters')) {
      return json({ categories: [], sources: [], ageTargets: [], safety: [], statuses: [], sortFields: [] });
    }
    if (path.includes('/stories')) return json({ stories: [story], total: 1 });
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

/** Clicks Regenerate on the only row and waits for the job to be reported. */
async function startJob(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Stored age 5');
  await user.click(screen.getByRole('button', { name: /Regenerate/ }));
  await screen.findByRole('button', { name: /Regenerating/ });
}

/** Lets the job report itself finished, then waits for the dialog. */
async function finishJob() {
  jobRunning = false;
  done = 3;
  await screen.findByText('Regenerate — review before applying', {}, { timeout: 6000 });
}

beforeEach(() => {
  jobRunning = false;
  jobLost = false;
  done = 1;
  startStatus = 202;
  applyBody = null;
  discarded = false;
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('starting a story-scoped regeneration', () => {
  it('reports progress on the row while the job runs', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);

    const button = await screen.findByRole('button', { name: /Regenerating… 1\/3/ }, { timeout: 6000 });
    expect(button).toBeDisabled();
    // The whole row is locked: the server takes one job at a time.
    expect(screen.getByRole('button', { name: /Publish/ })).toBeDisabled();
  });

  it('opens the dialog with one tab per age once it finishes', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);
    await finishJob();

    for (const age of [5, 8, 14]) {
      expect(screen.getByRole('tab', { name: new RegExp(`Age ${age}`) })).toBeInTheDocument();
    }
    expect(screen.getByText('Fresh age 5')).toBeInTheDocument();
  });

  it('reports a refusal from the server', async () => {
    startStatus = 409;
    const user = userEvent.setup();
    view();
    await screen.findByText('Stored age 5');

    await user.click(screen.getByRole('button', { name: /Regenerate/ }));

    expect(await screen.findByText(/A scrape is already running/)).toBeInTheDocument();
  });

  it('says so when the preview is lost mid-run', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);

    // A server restart: the job is gone and nothing was written.
    jobLost = true;

    expect(
      await screen.findByText(/regenerate preview was lost/i, {}, { timeout: 6000 }),
    ).toBeInTheDocument();
  });
});

describe('applying a story-scoped regeneration', () => {
  it('sends the job id and exactly the ticked ages', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);
    await finishJob();

    await user.click(screen.getByRole('checkbox', { name: 'Apply age 8' }));
    await user.click(screen.getByRole('button', { name: 'Apply 2 of 3 versions' }));

    await waitFor(() => expect(applyBody).toEqual({ jobId: 'job-1', ages: [5, 14] }));
    await waitFor(() =>
      expect(screen.queryByText('Regenerate — review before applying')).not.toBeInTheDocument(),
    );
  });

  it('discards without applying', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);
    await finishJob();

    await user.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(discarded).toBe(true));
    expect(applyBody).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/__tests__/admin-regenerate.test.tsx`
Expected: FAIL — the row still awaits the old preview response, so no `Regenerating… 1/3` button appears.

- [ ] **Step 3: Write the hook**

Create `web/src/pages/admin/review/useRegenerateJob.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../admin/AdminAuthContext';
import type { RegenerateJob } from '../../../admin/types';

const POLL_MS = 2000;
const OFFLINE = '⚠ Could not reach the server. Check it is running, then try again.';
const LOST = '⚠ The regenerate preview was lost. Try again.';

export interface RegenerateController {
  /** The held preview, running or finished. Null when there is none. */
  job: RegenerateJob | null;
  /** The version id a start request is in flight for, so the row can say so
   *  before the server has answered. */
  startingId: string | null;
  start: (id: string) => Promise<void>;
  apply: (ages: number[]) => Promise<void>;
  discard: () => Promise<void>;
}

/**
 * Starting, watching and applying a story-scoped regeneration (§4.2).
 *
 * Lives outside AdminReview because the page already owns three kinds of async
 * state and this one is a job: it has progress, a lifecycle and a poll. Every
 * message goes through the page's existing notice, so an editor reads one line
 * in one place whatever they just did.
 */
export function useRegenerateJob({
  setNotice,
  onApplied,
}: {
  setNotice: (notice: string | null) => void;
  onApplied: () => Promise<void> | void;
}): RegenerateController {
  const { adminFetch } = useAdminAuth();
  const [job, setJob] = useState<RegenerateJob | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  /** Polls while it runs: ten ages is minutes, so the row cannot just wait. */
  useEffect(() => {
    if (!job?.running) return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await adminFetch('/api/admin/articles/regenerate/status');
          if (!res.ok) return;

          const body = (await res.json()) as { running: boolean; job: RegenerateJob | null };
          // A restart mid-run loses the preview. Nothing was written, so saying
          // so beats spinning forever on a job that no longer exists.
          if (!body.job) { setJob(null); setNotice(LOST); return; }
          if (body.job.error) { setJob(null); setNotice(`⚠ ${body.job.error}`); return; }
          setJob(body.job);
        } catch {
          // A dropped poll is retried on the next tick.
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [job?.running, adminFetch, setNotice]);

  const start = useCallback(
    async (id: string) => {
      setNotice(null);
      setStartingId(id);
      try {
        const res = await adminFetch(`/api/admin/articles/${id}/regenerate`, { method: 'POST' });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setNotice(`⚠ ${body.error ?? 'Could not start regenerating.'}`);
          return;
        }
        setJob(((await res.json()) as { job: RegenerateJob }).job);
      } catch {
        setNotice(OFFLINE);
      } finally {
        setStartingId(null);
      }
    },
    [adminFetch, setNotice],
  );

  const apply = useCallback(
    async (ages: number[]) => {
      if (!job) return;
      setNotice(null);
      try {
        const res = await adminFetch('/api/admin/articles/regenerate/apply', {
          method: 'POST',
          body: JSON.stringify({ jobId: job.id, ages }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setNotice(`⚠ ${body.error ?? 'Could not apply the regenerated versions.'}`);
          return;
        }
        setJob(null);
        setNotice(`Applied to ${ages.length} version(s): age ${ages.join(', ')}.`);
        await onApplied();
      } catch {
        setNotice(OFFLINE);
      }
    },
    [adminFetch, job, onApplied, setNotice],
  );

  const discard = useCallback(async () => {
    setJob(null);
    try {
      await adminFetch('/api/admin/articles/regenerate', { method: 'DELETE' });
    } catch {
      // The preview is already gone from the editor's view, and the server
      // drops its copy the next time a regeneration starts.
    }
  }, [adminFetch]);

  return { job, startingId, start, apply, discard };
}
```

- [ ] **Step 4: Show progress on the row**

In `web/src/pages/admin/review/StoryRow.tsx`, add the prop to the signature and its type:

```tsx
export function StoryRow({
  story,
  selected,
  onSelectedChange,
  actions,
  pending = null,
  locked = false,
  progress = null,
}: {
  story: AdminStory;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  actions: RowActions;
  pending?: PendingAction;
  /** True while any action anywhere in the queue is running. */
  locked?: boolean;
  /** Live counter while this story's regeneration job runs. */
  progress?: { done: number; total: number } | null;
}) {
```

Replace the Regenerate button's label expression:

```tsx
            {progress
              ? `Regenerating… ${progress.done}/${progress.total}`
              : pending === 'regenerate'
                ? 'Regenerating…'
                : 'Regenerate'}
```

- [ ] **Step 5: Wire the queue**

In `web/src/pages/admin/AdminReview.tsx`:

1. Add the import beside the other review imports:

```tsx
import { useRegenerateJob } from './review/useRegenerateJob';
```

2. Delete the `regenerating` state line:

```tsx
  const [regenerating, setRegenerating] = useState<{ current: AdminArticle; generated: AdminArticle } | null>(null);
```

3. Immediately after `const { notice, setNotice, run: act } = useAdminAction(load);`, add:

```tsx
  // §4.2 Regenerate is a background job over every age version (§5), so it
  // has progress and a lifecycle rather than a single awaited request.
  const regen = useRegenerateJob({ setNotice, onApplied: load });
```

4. Delete the whole `openRegenerate` function.

5. In the `stories.map` body, extend the id block and the three props:

```tsx
                  // Any version resolves to the story server-side; the youngest
                  // is the deterministic choice.
                  const id = story.versions[0].id;
                  const running = regen.job?.running ? regen.job : null;
                  const isRegenerating =
                    regen.startingId === id || running?.originalId === story.originalId;
                  return (
                    <StoryRow
                      key={story.originalId}
                      story={story}
                      selected={selected.has(id)}
                      onSelectedChange={(isSelected) => toggleSelected(id, isSelected)}
                      pending={
                        pending?.id === id ? pending.action : isRegenerating ? 'regenerate' : null
                      }
                      locked={pending !== null || regen.startingId !== null || running !== null}
                      progress={
                        running?.originalId === story.originalId
                          ? { done: running.done, total: running.ages.length }
                          : null
                      }
```

and the action itself:

```tsx
                        onRegenerate: () => void regen.start(id),
```

6. Replace the `{regenerating && (...)}` render block at the end of the component with:

```tsx
      {regen.job && !regen.job.running && regen.job.versions.length > 0 && (
        <RegenerateDialog
          job={regen.job}
          onDiscard={() => void regen.discard()}
          onApply={(ages) => void regen.apply(ages)}
        />
      )}
```

- [ ] **Step 6: Run the new suite to verify it passes**

Run: `cd web && npx vitest run src/__tests__/admin-regenerate.test.tsx`
Expected: PASS — all six tests.

- [ ] **Step 7: Repair `admin-review.test.tsx`**

Delete the `describe('regenerate requires confirmation (requirement 12)', ...)` block in full (its four tests are covered by `admin-regenerate.test.tsx` and the dialog suite), and delete the now-dead mock branch:

```tsx
    if (path.includes('/regenerate')) {
      return json({ current: articles[0], generated: { ...articles[0], kidHeadline: 'Regenerated headline', summary: 'New summary.' } });
    }
```

- [ ] **Step 8: Repair `admin-ux.test.tsx`**

Add a status branch **above** the `if (method === 'GET') return json({ articles, total: articles.length });` line, so the poll is not answered with an article list:

```tsx
    if (path.includes('/articles/regenerate/status')) {
      return json({
        running: true,
        job: {
          id: 'job-1', originalId: ARTICLE.originalId, kidHeadline: ARTICLE.kidHeadline,
          startedAt: '2026-09-10T09:00:00.000Z', ages: [ARTICLE.ageTarget], done: 0,
          running: true, versions: [], costUsd: 0,
        },
      });
    }
```

Replace the old `/regenerate` branch (below the `slowMutations` gate) with the job-start response:

```tsx
    if (path.includes('/regenerate')) {
      return json({
        running: true,
        job: {
          id: 'job-1', originalId: ARTICLE.originalId, kidHeadline: ARTICLE.kidHeadline,
          startedAt: '2026-09-10T09:00:00.000Z', ages: [ARTICLE.ageTarget], done: 0,
          running: true, versions: [], costUsd: 0,
        },
      }, 202);
    }
```

The two tests in `describe('feedback while an action runs')` keep working for the reason they were written: `startingId` makes the row say `Regenerating…` the instant it is clicked, before the server answers, so a slow start still shows feedback and still refuses a second click.

- [ ] **Step 9: Run the whole web suite and typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS. If `grep -rn "setRegenerating\|regenerate/apply'" web/src` prints anything outside `useRegenerateJob.ts`, a caller of the old shape was missed.

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/admin/review/useRegenerateJob.ts web/src/pages/admin/AdminReview.tsx \
        web/src/pages/admin/review/StoryRow.tsx web/src/__tests__/admin-regenerate.test.tsx \
        web/src/__tests__/admin-review.test.tsx web/src/__tests__/admin-ux.test.tsx
git commit -m "feat: run Regenerate as a story-wide job from the review queue"
```

---

### Task 6: Documentation and the full gate

The README's story-scope paragraph still names four story-scoped actions and calls Edit the only exception. That is now wrong, and it is the paragraph a new contributor reads to learn the scope rules.

**Files:**
- Modify: `README.md:231-236` (the story-scope paragraph)
- Modify: `docs/superpowers/specs/2026-09-10-story-scoped-regenerate-design.md` (status line)

**Interfaces:**
- Consumes: the behaviour delivered by Tasks 1-5.
- Produces: no code.

- [ ] **Step 1: Update the README's scope paragraph**

Replace the paragraph beginning `Publish, reject, re-review and delete are **story-scoped**:` with:

```markdown
Publish, reject, re-review, delete and regenerate are **story-scoped**: they
take any one version's id and apply to every version of that story, so a
story's versions always share one status. The endpoint URLs are unchanged from
when a story had one version — `PATCH /api/admin/articles/:id/publish` now
publishes the story that id belongs to. **Edit is the exception** and stays
per-version, so one age's wording can be fixed without touching the other nine,
and `editedByHuman` stays a per-version flag.

**Regenerate previews every age and applies the ones you tick.** Ten versions
is ten sequential model calls, so `POST /api/admin/articles/:id/regenerate`
starts a background job and the row polls
`GET /api/admin/articles/regenerate/status` — the same shape as a scrape or a
manual simplify batch, and the same one-job-at-a-time lock. The dialog shows a
tab per age with its own diff; ages a person has edited arrive unticked.
`POST /api/admin/articles/regenerate/apply` writes the ticked ages from the
held preview, so applying costs no further model calls and writes exactly the
text that was on screen.
```

- [ ] **Step 2: Mark the spec delivered**

In `docs/superpowers/specs/2026-09-10-story-scoped-regenerate-design.md`, change the status line to:

```markdown
**Status:** implemented — see `docs/superpowers/plans/2026-09-10-story-scoped-regenerate.md`
```

- [ ] **Step 3: Run the full gate**

Run: `cd server && npm test && npm run typecheck && cd ../web && npm test && npm run typecheck`
Expected: PASS on all four. Do not report the feature complete on anything less than four passes; quote the counts.

- [ ] **Step 4: Confirm the old shape is gone**

Run: `grep -rn "regenerateArticle\|regenerate/apply" server/src web/src | grep -v "articles/regenerate/apply"`
Expected: no output. Any hit is a leftover caller of the deleted per-version endpoint.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-10-story-scoped-regenerate-design.md
git commit -m "docs: describe story-scoped regenerate and its per-age apply"
```

---

## Manual check before merging

Tests prove the wiring; they do not prove it reads well. With `LLM_ENABLED=1` and a story in the queue:

1. Click **Regenerate** on a ten-version story. The button should say `Regenerating… n/10` and climb, and every other button in the queue should be disabled.
2. When the dialog opens, the tab strip should scroll rather than wrap, and the preview cost should be a real number.
3. Untick two ages, apply, and confirm the notice names the count. Re-open the queue and check the two unticked ages still hold their old wording.
4. Edit one age by hand, then regenerate again: that age must arrive unticked and badged `✎`.
5. Start a regeneration and, while it runs, try **Run now** on `/admin/settings` — it must be refused with the 409 message naming the regeneration.
