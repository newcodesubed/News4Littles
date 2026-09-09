# Per-Age Versions — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The review queue shows one row per story instead of ten, and approving a story publishes all ten of its age versions together.

**Architecture:** A new `GET /api/admin/stories` reuses the existing `query()` filter builder to find matching versions, then returns one row per `originalId` with every version nested and a story-level strictest-safety verdict. The existing row-action endpoints keep their URLs but become story-scoped, resolving an id to its `originalId` and updating every sibling. Edit stays per-version. Tab counts become `COUNT(DISTINCT originalId)`.

**Tech Stack:** Node.js 20+, TypeScript (ESM, `.js` import specifiers), better-sqlite3 with raw SQL, Express 4, Vitest; React 18 + Vite + Tailwind + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-09-per-age-versions-design.md` (Phase 2 is §5; Phase 1 shipped, Phase 3 is a later plan)

## Global Constraints

- Ages are `MIN_AGE = 5` to `MAX_AGE = 14` from `server/src/core/article.ts`. Never hardcode 5, 14 or 10.
- **Never auto-publish.** Publishing is only ever an explicit editor action (§2.2).
- **A story's safety is the strictest across its versions.** Never show or act on one version's verdict as if it were the story's — §6 says the strictest result wins, and a story that is `skip-young` at age 5 must not be treated as `calm` because age 14 is.
- **Bulk approve must still exclude `skip-young` unless the editor opts in** (§4.2). With story-scoped actions this check has to use the story's strictest safety, or selecting a calm age-14 version would publish a skip-young age-5 version.
- Publish, reject, unpublish and delete are **story-scoped**. Edit is **per-version**; `editedByHuman` stays a per-version flag.
- `GET /api/admin/articles` (flat, per-version) stays exactly as it is — §4.2's age filter and `distinctAgeTargets()` need per-version rows.
- Delete is refused for a published story (§4.2); unpublish first.
- Column names verbatim from the PRD's interfaces; `.js` extensions on every local import.
- Server tests: `cd server && npm test`. Web tests: `cd web && npm test`. Typecheck both.
- One-line commit messages, no body, no `Co-Authored-By` trailer.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `server/src/routes/admin/stories.ts` | `GET /api/admin/stories` — the grouped queue read |
| `web/src/pages/admin/review/StoryRow.tsx` | One queue row per story: strictest safety, version count, actions |
| `server/tests/admin-stories.test.ts` | The grouped endpoint and story-scoped actions |

**Modified:**

| File | Change |
|---|---|
| `server/src/db/repositories/articleRepository.ts` | `queryStories`, `findStoryState`, story-scoped mutations, story-level counts |
| `server/src/routes/admin/articleActions.ts` | Row actions become story-scoped; comments say so |
| `server/src/routes/admin/articleBulk.ts` | Expand ids to stories; strictest-safety opt-in check |
| `server/src/routes/admin/articleQueue.ts` | `counts` become story-level |
| `server/src/app.ts` | Mount the stories router |
| `web/src/admin/types.ts` | `AdminStory` |
| `web/src/pages/admin/AdminReview.tsx` | Load stories, render `StoryRow` |
| `web/src/pages/admin/dialogs/ViewArticleDialog.tsx` | Age selector across a story's versions |
| `README.md` | Story-scoped actions and the grouped queue |

---

## Task 1: Story-level reads in the repository

**Files:**
- Modify: `server/src/db/repositories/articleRepository.ts`
- Test: `server/tests/admin-queue.test.ts`

**Interfaces:**
- Consumes: the existing `query(query: ArticleQuery): AdminArticle[]` and its filter builder.
- Produces:
  ```ts
  export interface AdminStory {
    originalId: string;
    /** Every version, ascending by ageTarget. Never empty. */
    versions: AdminArticle[];
    /** The strictest safety across versions (§6). */
    safety: Safety;
    /** Shared by every version, because status is story-scoped. */
    status: ArticleStatus;
    /** The youngest version's headline, as the row's label. */
    kidHeadline: string;
    /** From the youngest version; the same for every version. */
    category: string;
    sourceId: string;
    originalHeadline: string;
    createdAt: string;
  }
  queryStories(query: ArticleQuery): AdminStory[]
  countsByStatus(): Record<ArticleStatus, number> & { total: number }   // now stories, not versions
  ```

**Why reuse `query()`:** the filter builder already handles status, category, safety, source, age, search, date ranges and sorting. Duplicating it for stories would guarantee the two drift apart. `queryStories` filters versions with it, collects the distinct `originalId`s in the order returned, then loads every version of those stories.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/admin-queue.test.ts`:

```ts
describe('story-level reads (§5)', () => {
  it('returns one row per story with every version nested', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'story-raw', headline: 'Adult headline', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    for (const age of [5, 6, 7]) {
      insertKidArticle(ctx.db, {
        id: `v-${age}`, originalId: raw, ageTarget: age, status: 'pending_review',
        kidHeadline: `Version for ${age}`, createdAt: '2026-09-06T10:00:00.000Z',
      });
    }

    const stories = await (await ctx.api('/api/admin/stories?status=pending_review')).json();
    const story = stories.stories.find((s: any) => s.originalId === raw);

    expect(story.versions).toHaveLength(3);
    expect(story.versions.map((v: any) => v.ageTarget)).toEqual([5, 6, 7]);
    // Labelled by the youngest version.
    expect(story.kidHeadline).toBe('Version for 5');
    expect(story.originalHeadline).toBe('Adult headline');
  });

  it('reports the strictest safety across a story’s versions', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'mixed-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, { id: 'mixed-5', originalId: raw, ageTarget: 5, safety: 'skip-young' });
    insertKidArticle(ctx.db, { id: 'mixed-14', originalId: raw, ageTarget: 14, safety: 'calm' });

    const stories = await (await ctx.api('/api/admin/stories?status=pending_review')).json();
    const story = stories.stories.find((s: any) => s.originalId === raw);

    // §6: the strictest wins. Showing 'calm' here would hide a skip-young
    // version from the editor about to approve the whole story.
    expect(story.safety).toBe('skip-young');
  });

  it('returns a whole story when any one version matches the filter', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'agefilter-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, { id: 'af-5', originalId: raw, ageTarget: 5 });
    insertKidArticle(ctx.db, { id: 'af-14', originalId: raw, ageTarget: 14 });

    const stories = await (await ctx.api('/api/admin/stories?ageTarget=14')).json();
    const story = stories.stories.find((s: any) => s.originalId === raw);

    // Filtered on age 14, but both versions come back: the editor reviews the
    // whole story, not the one version that matched.
    expect(story.versions.map((v: any) => v.ageTarget)).toEqual([5, 14]);
  });

  it('counts stories, not versions', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'counted-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    for (const age of [5, 6, 7, 8]) {
      insertKidArticle(ctx.db, { id: `c-${age}`, originalId: raw, ageTarget: age, status: 'rejected' });
    }

    const counts = await (await ctx.api('/api/admin/articles/counts')).json();

    // Asserted as a relationship rather than a literal: this file uses
    // beforeAll, so row counts depend on test order, and a literal here would
    // break every time a test is added above it.
    const versionRows = ctx.db
      .prepare(`SELECT COUNT(*) c FROM kid_articles WHERE status = 'rejected'`).pluck().get();
    const storyRows = ctx.db
      .prepare(`SELECT COUNT(DISTINCT originalId) c FROM kid_articles WHERE status = 'rejected'`)
      .pluck().get();

    // The fixture above makes these differ, which is what makes the test mean
    // something: four versions, one story.
    expect(versionRows).toBeGreaterThan(storyRows as number);
    expect(counts.rejected).toBe(storyRows);
  });

  it('needs admin auth', async () => {
    expect((await ctx.anon('/api/admin/stories')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/admin-queue.test.ts`
Expected: FAIL — 404 on `/api/admin/stories`, and `counts.rejected` equals the version count rather than the story count.

- [ ] **Step 3: Add the repository reads**

In `server/src/db/repositories/articleRepository.ts`, add the type beneath `AdminArticle`:

```ts
/**
 * One story as the review queue shows it: every age version, plus the
 * story-level facts an editor decides on.
 *
 * `safety` is the STRICTEST across versions (§6). A story that is skip-young at
 * age 5 must never present as calm because age 14 is — the editor is about to
 * approve all ten at once.
 */
export interface AdminStory {
  originalId: string;
  /** Every version, ascending by ageTarget. Never empty. */
  versions: AdminArticle[];
  safety: Safety;
  /** Shared by every version: publish, reject and delete are story-scoped. */
  status: ArticleStatus;
  /** The youngest version's headline, as the row's label. */
  kidHeadline: string;
  category: string;
  sourceId: string;
  originalHeadline: string;
  createdAt: string;
}
```

Add `SAFETY_SEVERITY` near the top of the file, below the imports:

```ts
/** §6's severity order, for collapsing a story's versions to one verdict. */
const SAFETY_SEVERITY: Record<Safety, number> = {
  calm: 0, 'adult-nearby': 1, 'skip-young': 2,
};
```

Add to the interface:

```ts
  /** §5: one row per story, for the grouped review queue. */
  queryStories(query: ArticleQuery): AdminStory[];
  /** Status plus the story's STRICTEST safety, for deciding an action. */
  findStoryState(id: string): { originalId: string; status: ArticleStatus; safety: Safety } | undefined;
```

Add the prepared statements to `statements`:

```ts
    versionsForStories: (count: number) =>
      db.prepare(
        `${ADMIN_SELECT} WHERE k.originalId IN (${Array(count).fill('?').join(', ')})
         ORDER BY k.ageTarget`,
      ),
    storyCounts: db.prepare(
      `SELECT status, COUNT(DISTINCT originalId) AS n FROM kid_articles GROUP BY status`,
    ),
    storyStateFor: db.prepare(
      `SELECT originalId, status, safety FROM kid_articles
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = ?)`,
    ),
```

Add the implementations:

```ts
    queryStories(query) {
      // The filter runs over VERSIONS, reusing the one filter builder, so the
      // flat and grouped queues can never disagree about what matches.
      const matched = this.query(query);
      if (matched.length === 0) return [];

      // Distinct originalIds in the order query() returned them, so the
      // caller's sort still decides the order stories appear in.
      const order: string[] = [];
      const seen = new Set<string>();
      for (const version of matched) {
        if (seen.has(version.originalId)) continue;
        seen.add(version.originalId);
        order.push(version.originalId);
      }

      // Every version of those stories, not just the ones that matched: an
      // editor approving a story is approving all of it.
      const rows = statements
        .versionsForStories(order.length)
        .all(...order) as AdminArticleRow[];

      const byStory = new Map<string, AdminArticle[]>();
      for (const row of rows) {
        const version = toAdminArticle(row);
        const list = byStory.get(version.originalId);
        if (list) list.push(version);
        else byStory.set(version.originalId, [version]);
      }

      return order.flatMap((originalId) => {
        const versions = byStory.get(originalId);
        if (!versions || versions.length === 0) return [];

        const youngest = versions[0];
        return [{
          originalId,
          versions,
          safety: versions.reduce<Safety>(
            (worst, v) => (SAFETY_SEVERITY[v.safety] > SAFETY_SEVERITY[worst] ? v.safety : worst),
            'calm',
          ),
          status: youngest.status,
          kidHeadline: youngest.kidHeadline,
          category: youngest.category,
          sourceId: youngest.sourceId,
          originalHeadline: youngest.originalHeadline,
          createdAt: youngest.createdAt,
        }];
      });
    },

    findStoryState(id) {
      const rows = statements.storyStateFor.all(id) as
        { originalId: string; status: ArticleStatus; safety: Safety }[];
      if (rows.length === 0) return undefined;

      return {
        originalId: rows[0].originalId,
        status: rows[0].status,
        // The strictest, so a bulk approve cannot slip a skip-young version
        // through because the selected version happened to be calm.
        safety: rows.reduce<Safety>(
          (worst, row) => (SAFETY_SEVERITY[row.safety] > SAFETY_SEVERITY[worst] ? row.safety : worst),
          'calm',
        ),
      };
    },
```

Change `countsByStatus` to count stories:

```ts
    countsByStatus() {
      // DISTINCT originalId: ten age versions are ONE story to review, and a
      // Pending badge reading 100 for ten stories is useless.
      const counts = { pending_review: 0, published: 0, rejected: 0, total: 0 };
      for (const row of statements.storyCounts.all() as { status: ArticleStatus; n: number }[]) {
        counts[row.status] = row.n;
        counts.total += row.n;
      }
      return counts;
    },
```

`queryStories` calls `this.query(...)`, so the returned object literal must be assigned to a named const the methods can reference. If the file returns an anonymous object literal, extract it: `const repository: ArticleRepository = { ... }; return repository;` and use `repository.query(query)` instead of `this.query(query)`.

- [ ] **Step 4: Add the route**

Create `server/src/routes/admin/stories.ts`:

```ts
/**
 * The review queue, grouped by story (§5).
 *
 * A story is one raw article's ten age versions (§3.6). An editor reviews and
 * approves a story, not a version, so this endpoint returns one row per story
 * with every version nested — and a story-level safety verdict that is the
 * STRICTEST across those versions (§6), because approving the row approves all
 * of them.
 *
 * The flat `GET /articles` stays: §4.2's age filter and the filter dropdowns
 * need per-version rows.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { FLAGGED_SAFETY, SAFETY_VALUES } from '../../core/article.js';
import {
  createArticleRepository, SORTABLE_FIELDS, type ArticleQuery,
} from '../../db/repositories/articleRepository.js';
import {
  parseBool, parseList, requireInt, requireOneOf, requireSafetyList, requireStatus,
} from '../../http/validation.js';

/** A trimmed query-string value, or undefined. */
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export function createStoriesRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);

  router.get('/stories', (req, res) => {
    const { status, category, safety, source, ageTarget, q, sort, order } = req.query;

    const safeties = parseBool(req.query.flagged)
      ? [...FLAGGED_SAFETY]
      : requireSafetyList(parseList(safety));

    const query: ArticleQuery = {
      status: status === undefined ? undefined : requireStatus(status),
      categories: parseList(category),
      safeties,
      sourceIds: parseList(source),
      ageTargets: parseList(ageTarget).map((value) => requireInt(value, 'ageTarget')),
      search: text(q),
      createdFrom: text(req.query.createdFrom),
      createdTo: text(req.query.createdTo),
      publishedFrom: text(req.query.publishedFrom),
      publishedTo: text(req.query.publishedTo),
      sort: sort === undefined ? 'createdAt' : requireOneOf(sort, SORTABLE_FIELDS, 'sort'),
      order: String(order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    };

    const stories = articles.queryStories(query);
    res.json({ stories, total: stories.length });
  });

  return router;
}
```

`SAFETY_VALUES` is imported for parity with `articleQueue.ts`; if the linter flags it as unused, drop it from the import rather than adding a use for it.

Mount it in `server/src/app.ts`:

```ts
import { createStoriesRouter } from './routes/admin/stories.js';
// ...in ADMIN_ROUTERS, next to createArticleQueueRouter:
  createStoriesRouter,
```

- [ ] **Step 5: Run the tests**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS for the new tests. `admin-queue.test.ts`'s existing `reports one number per status` asserts version counts (`pending_review: 4, published: 1, rejected: 1, total: 6`) — those fixtures are one version per story, so the numbers are unchanged. If any other suite asserts a count that was version-based, that is a real semantic change: update the expectation and say so.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/repositories/articleRepository.ts server/src/routes/admin/stories.ts \
        server/src/app.ts server/tests/admin-queue.test.ts
git commit -m "feat: read the review queue one row per story"
```

---

## Task 2: Story-scoped row actions

**Files:**
- Modify: `server/src/db/repositories/articleRepository.ts`
- Modify: `server/src/routes/admin/articleActions.ts`
- Test: `server/tests/admin-stories.test.ts` (new)

**Interfaces:**
- Consumes: `findStoryState(id)` (Task 1).
- Produces: `publishStory(id, at)`, `rejectStory(id, reason)`, `returnStoryToQueue(id)`, `removeStory(id)` — each resolves the id to its `originalId` and affects every sibling version. `applyEdit` is untouched and stays per-version.

**The semantic change:** `PATCH /articles/:id/publish` used to publish one row and now publishes the story. The URL is unchanged so the admin UI keeps working; the route comments and the README must say what changed, because the next reader will otherwise assume per-version.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/admin-stories.test.ts`:

```ts
/**
 * Story-scoped row actions (§5).
 *
 * A story is one raw article's age versions. An editor approves the story, so
 * every version has to move together — and the skip-young opt-in has to be
 * judged on the story's strictest version, not on whichever one was clicked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countRows, createTestContext, getKidArticle, insertKidArticle, insertRawArticle,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

/** A story with one version per given age. Returns the version ids by age. */
function seedStory(
  rawId: string,
  ages: number[],
  overrides: Record<number, Record<string, unknown>> = {},
) {
  const raw = insertRawArticle(ctx.db, {
    id: rawId, headline: `Adult headline ${rawId}`, simplifiedAt: '2026-09-06T09:00:00.000Z',
  });
  const ids: Record<number, string> = {};
  for (const age of ages) {
    ids[age] = insertKidArticle(ctx.db, {
      id: `${rawId}-v${age}`, originalId: raw, ageTarget: age,
      kidHeadline: `Version for ${age}`, ...(overrides[age] ?? {}),
    });
  }
  return ids;
}

const statuses = (rawId: string) =>
  ctx.db.prepare(`SELECT DISTINCT status FROM kid_articles WHERE originalId = ?`)
    .pluck().all(rawId);

describe('publishing a story', () => {
  it('publishes every version, not just the one clicked', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const res = await ctx.api(`/api/admin/articles/${ids[8]}/publish`, { method: 'PATCH' });
    expect(res.status).toBe(200);

    expect(statuses('s1')).toEqual(['published']);
    // §4.2: a published row must carry publishedAt, and the schema CHECK
    // enforces it — so every version needs one, not just the clicked version.
    const withoutDate = ctx.db
      .prepare(`SELECT COUNT(*) c FROM kid_articles WHERE originalId = 's1' AND publishedAt IS NULL`)
      .pluck().get();
    expect(withoutDate).toBe(0);
  });

  it('leaves other stories alone', async () => {
    const ids = seedStory('s1', [5, 8]);
    seedStory('s2', [5, 8]);

    await ctx.api(`/api/admin/articles/${ids[5]}/publish`, { method: 'PATCH' });

    expect(statuses('s1')).toEqual(['published']);
    expect(statuses('s2')).toEqual(['pending_review']);
  });
});

describe('rejecting, unpublishing and deleting a story', () => {
  it('rejects every version with the same reason', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    await ctx.api(`/api/admin/articles/${ids[14]}/reject`, {
      method: 'PATCH', body: JSON.stringify({ reason: 'Too grim' }),
    });

    expect(statuses('s1')).toEqual(['rejected']);
    const reasons = ctx.db
      .prepare(`SELECT DISTINCT rejectReason FROM kid_articles WHERE originalId = 's1'`)
      .pluck().all();
    expect(reasons).toEqual(['Too grim']);
  });

  it('returns every version to the queue', async () => {
    const ids = seedStory('s1', [5, 8]);
    await ctx.api(`/api/admin/articles/${ids[5]}/publish`, { method: 'PATCH' });

    await ctx.api(`/api/admin/articles/${ids[8]}/unpublish`, { method: 'PATCH' });

    expect(statuses('s1')).toEqual(['pending_review']);
    const dates = ctx.db
      .prepare(`SELECT DISTINCT publishedAt FROM kid_articles WHERE originalId = 's1'`)
      .pluck().all();
    expect(dates).toEqual([null]);
  });

  it('deletes every version', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const res = await ctx.api(`/api/admin/articles/${ids[5]}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    // The raw article survives, so the story can be simplified again (§4.2).
    expect(countRows(ctx.db, 'raw_articles')).toBe(1);
  });

  it('refuses to delete a published story', async () => {
    const ids = seedStory('s1', [5, 8]);
    await ctx.api(`/api/admin/articles/${ids[5]}/publish`, { method: 'PATCH' });

    const res = await ctx.api(`/api/admin/articles/${ids[8]}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect(countRows(ctx.db, 'kid_articles')).toBe(2);
  });
});

describe('editing one version', () => {
  it('changes only the version edited', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    await ctx.api(`/api/admin/articles/${ids[8]}`, {
      method: 'PATCH', body: JSON.stringify({ kidHeadline: 'Reworded for eights' }),
    });

    expect(getKidArticle(ctx.db, ids[8])!.kidHeadline).toBe('Reworded for eights');
    expect(getKidArticle(ctx.db, ids[5])!.kidHeadline).toBe('Version for 5');
    expect(getKidArticle(ctx.db, ids[14])!.kidHeadline).toBe('Version for 14');
    // editedByHuman stays per-version: only age 8 was touched by a person.
    expect(getKidArticle(ctx.db, ids[8])!.editedByHuman).toBe(1);
    expect(getKidArticle(ctx.db, ids[5])!.editedByHuman).toBe(0);
  });
});

describe('bulk actions over stories', () => {
  it('approving one version of a story approves the story', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const res = await ctx.api('/api/admin/articles/bulk', {
      method: 'POST', body: JSON.stringify({ ids: [ids[8]], action: 'approve' }),
    });
    expect(res.status).toBe(200);

    expect(statuses('s1')).toEqual(['published']);
  });

  it('skips a story whose STRICTEST version is skip-young, even when the selected version is calm', async () => {
    // The safety hole story-scoping would otherwise open: the editor selects
    // the calm age-14 row and unknowingly publishes a skip-young age-5 one.
    const ids = seedStory('s1', [5, 14], {
      5: { safety: 'skip-young', feelingNote: 'A gentle note.' },
      14: { safety: 'calm' },
    });

    const body = await (await ctx.api('/api/admin/articles/bulk', {
      method: 'POST', body: JSON.stringify({ ids: [ids[14]], action: 'approve' }),
    })).json();

    expect(body.skippedCount).toBe(1);
    expect(body.skipped[0].reason).toMatch(/skip-young/);
    expect(statuses('s1')).toEqual(['pending_review']);
  });

  it('publishes that story when the editor opts in', async () => {
    const ids = seedStory('s1', [5, 14], {
      5: { safety: 'skip-young', feelingNote: 'A gentle note.' },
      14: { safety: 'calm' },
    });

    await ctx.api('/api/admin/articles/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [ids[14]], action: 'approve', includeFlagged: true }),
    });

    expect(statuses('s1')).toEqual(['published']);
  });

  it('counts a story once even when several of its versions are selected', async () => {
    const ids = seedStory('s1', [5, 8, 14]);

    const body = await (await ctx.api('/api/admin/articles/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [ids[5], ids[8], ids[14]], action: 'approve' }),
    })).json();

    // One story approved, not three.
    expect(body.appliedCount).toBe(1);
    expect(statuses('s1')).toEqual(['published']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/admin-stories.test.ts`
Expected: FAIL — publishing one version leaves the siblings `pending_review`, so `statuses('s1')` is `['pending_review', 'published']`.

- [ ] **Step 3: Add the story-scoped mutations**

In `server/src/db/repositories/articleRepository.ts`, add to the interface beneath the per-version mutations:

```ts
  /**
   * §5: publish, reject, unpublish and delete are STORY-scoped — an editor
   * approves a story, and every age version has to move with it. Each takes any
   * one version's id and resolves it to the story.
   */
  publishStory(id: string, at: string): void;
  rejectStory(id: string, reason: string | null): void;
  returnStoryToQueue(id: string): void;
  removeStory(id: string): void;
```

Add the statements. `WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`
resolves the story from any of its versions in one statement:

```ts
    publishStory: db.prepare(
      `UPDATE kid_articles SET status='published', publishedAt=@at
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`,
    ),
    rejectStory: db.prepare(
      `UPDATE kid_articles SET status='rejected', rejectReason=@reason
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`,
    ),
    requeueStory: db.prepare(
      `UPDATE kid_articles SET status='pending_review', publishedAt=NULL, rejectReason=NULL
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = @id)`,
    ),
    removeStory: db.prepare(
      `DELETE FROM kid_articles
       WHERE originalId = (SELECT originalId FROM kid_articles WHERE id = ?)`,
    ),
```

and the implementations beside the per-version ones:

```ts
    publishStory: (id, at) => void statements.publishStory.run({ id, at }),
    rejectStory: (id, reason) => void statements.rejectStory.run({ id, reason }),
    returnStoryToQueue: (id) => void statements.requeueStory.run({ id }),
    removeStory: (id) => void statements.removeStory.run(id),
```

The per-version `publish`, `reject`, `returnToQueue` and `remove` stay: `applyRegeneration` and the tests that exercise a single row still use them.

- [ ] **Step 4: Point the routes at the story-scoped versions**

In `server/src/routes/admin/articleActions.ts`, replace the module comment's first line and the four handlers:

```ts
/**
 * Row actions on one story: publish / reject / re-review / edit / regenerate /
 * delete (§4.2).
 *
 * SCOPE (§5): a story is one raw article's ten age versions (§3.6), and an
 * editor approves the story. So publish, reject, unpublish and delete take any
 * one version's id and apply to EVERY version of that story. The URLs are
 * unchanged from when a story had one version; the scope is not.
 *
 * Edit is the exception and stays per-version, so one age's wording can be
 * fixed without touching the other nine.
 */
```

```ts
  /** Throws 404 rather than letting a route update a story that isn't there. */
  const requireStory = (id: string) => {
    const state = articles.findStoryState(id);
    if (!state) throw NotFoundError.of('article', id);
    return state;
  };

  router.patch('/articles/:id/publish', (req, res) => {
    requireStory(req.params.id);
    articles.publishStory(req.params.id, new Date().toISOString());
    respond(res, req.params.id);
  });

  router.patch('/articles/:id/reject', (req, res) => {
    requireStory(req.params.id);
    // §4.2: the reason is optional free text, stored on every version.
    articles.rejectStory(req.params.id, optionalString((req.body ?? {}).reason));
    respond(res, req.params.id);
  });

  router.patch('/articles/:id/unpublish', (req, res) => {
    requireStory(req.params.id);
    // §4.2: "move published/rejected items back to pending_review".
    articles.returnStoryToQueue(req.params.id);
    respond(res, req.params.id);
  });
```

and the delete handler:

```ts
  /** §4.2: delete is only ever allowed on a non-published story. */
  router.delete('/articles/:id', (req, res) => {
    const { status } = requireStory(req.params.id);
    if (status === 'published') {
      throw new ConflictError('Published articles cannot be deleted. Unpublish it first, then delete.');
    }
    articles.removeStory(req.params.id);
    res.json({ deleted: req.params.id });
  });
```

Leave the Edit handler and both Regenerate handlers using `requireArticle`/`findState` — they are per-version by design. Keep `requireArticle` for them; if it is now only used there, that is correct, not dead code.

- [ ] **Step 5: Make bulk actions story-aware**

In `server/src/routes/admin/articleBulk.ts`, replace the loop body:

```ts
    const outcome: BulkOutcome = { applied: [], skipped: [] };

    db.transaction(() => {
      // §5: actions are story-scoped, so several selected versions of one story
      // are one action. Deduplicated by originalId, or a story with ten
      // versions selected would be reported as ten approvals.
      const done = new Set<string>();

      for (const id of ids) {
        const state = articles.findStoryState(id);
        if (!state) {
          outcome.skipped.push({ id, reason: 'not found' });
          continue;
        }
        if (done.has(state.originalId)) continue;

        if (action === 'approve') {
          // §4.2: bulk approve must leave skip-young out unless the editor
          // explicitly opted in — judged on the story's STRICTEST version, so
          // selecting a calm age-14 row cannot publish a skip-young age-5 one.
          if (state.safety === 'skip-young' && !includeFlagged) {
            outcome.skipped.push({ id, reason: 'flagged skip-young' });
            continue;
          }
          articles.publishStory(id, now);
        } else if (action === 'reject') {
          articles.rejectStory(id, reason);
        } else {
          // §4.2: delete only for non-published items.
          if (state.status === 'published') {
            outcome.skipped.push({ id, reason: 'published — unpublish first' });
            continue;
          }
          articles.removeStory(id);
        }

        done.add(state.originalId);
        outcome.applied.push(id);
      }
    })();
```

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. `admin-actions.test.ts` exercises single-version stories, so story-scoped behaviour is identical there and those tests should not move. If one does fail, read it: a genuine scope change needs the expectation updated and called out.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/repositories/articleRepository.ts server/src/routes/admin/articleActions.ts \
        server/src/routes/admin/articleBulk.ts server/tests/admin-stories.test.ts
git commit -m "feat: make review actions apply to a whole story"
```

---

## Task 3: The queue renders one row per story

**Files:**
- Create: `web/src/pages/admin/review/StoryRow.tsx`
- Modify: `web/src/admin/types.ts`
- Modify: `web/src/pages/admin/AdminReview.tsx`
- Test: `web/src/__tests__/admin-review.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/stories` (Task 1), story-scoped actions (Task 2).
- Produces:
  ```ts
  export interface AdminStory {
    originalId: string;
    versions: AdminArticle[];
    safety: Safety;          // union, not string — SafetyBadge requires it
    status: ArticleStatus;
    kidHeadline: string;
    category: string;
    sourceId: string;
    originalHeadline: string;
    createdAt: string;
  }
  function StoryRow(props: {
    story: AdminStory;
    selected: boolean;
    onSelectedChange: (selected: boolean) => void;
    actions: RowActions;
    pending?: PendingAction;
    locked?: boolean;
  }): JSX.Element
  ```

`StoryRow` reuses `RowActions` and `PendingAction` from `./ArticleRow`, so the action wiring in `AdminReview` does not change shape. The id sent to every action endpoint is `story.versions[0].id` — any version resolves to the story, and the youngest is deterministic.

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/admin-review.test.tsx`. This file's mock returns `/articles`; add a `/stories` branch to it, building stories from the same `articles` fixture so the existing tests keep working:

```tsx
    if (path.includes('/stories')) {
      // Group the flat fixture the way the server does.
      const byStory = new Map<string, AdminArticle[]>();
      for (const a of articles) {
        const list = byStory.get(a.originalId);
        if (list) list.push(a);
        else byStory.set(a.originalId, [a]);
      }
      const rank: Record<string, number> = { calm: 0, 'adult-nearby': 1, 'skip-young': 2 };
      const stories = [...byStory.entries()].map(([originalId, versions]) => ({
        originalId,
        versions,
        safety: versions.reduce((w, v) => (rank[v.safety] > rank[w] ? v.safety : w), 'calm'),
        status: versions[0].status,
        kidHeadline: versions[0].kidHeadline,
        category: versions[0].category,
        sourceId: versions[0].sourceId,
        originalHeadline: versions[0].originalHeadline,
        createdAt: versions[0].createdAt,
      }));
      return json({ stories, total: stories.length });
    }
```

Then add a describe block:

```tsx
describe('one row per story (§5)', () => {
  it('shows a single row for a story with several age versions', async () => {
    articles = [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, kidHeadline: 'A calm story' }),
      article({ id: 'v8', originalId: 'raw-1', ageTarget: 8, kidHeadline: 'A calm story' }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14, kidHeadline: 'A calm story' }),
    ];
    view();

    // One row, not three.
    await waitFor(() => expect(screen.getAllByText('A calm story')).toHaveLength(1));
    expect(await screen.findByText(/3 reading ages/i)).toBeInTheDocument();
  });

  it('shows the strictest safety across the versions', async () => {
    articles = [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, safety: 'skip-young', feelingNote: 'note' }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14, safety: 'calm' }),
    ];
    view();

    // The editor is about to approve both, so the row must warn about age 5.
    expect(await screen.findByText(/skip-young/i)).toBeInTheDocument();
  });

  it('sends one version id when approving, and the server applies it to the story', async () => {
    articles = [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5 }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14 }),
    ];
    const user = userEvent.setup();
    view();
    await screen.findByText('A calm story');

    await user.click(screen.getByRole('button', { name: /publish/i }));

    await waitFor(() => {
      expect(calls.some((c) => c === 'PATCH /api/admin/articles/v5/publish')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/admin-review.test.tsx`
Expected: FAIL — three rows render, so `getAllByText('A calm story')` finds 3, and there is no "3 reading ages" text.

- [ ] **Step 3: Add the web type**

In `web/src/admin/types.ts`, beneath `AdminArticle`. `safety` and `status` must
be the union types, not `string`: `SafetyBadge` takes `safety: Safety`
(`Badges.tsx:78`), so a plain `string` fails to typecheck at the call site.

```ts
import type { ArticleStatus, KidArticle, Safety } from '../lib/types';

/**
 * One story as the grouped review queue shows it (§5): every age version, plus
 * the story-level facts an editor decides on. `safety` is the strictest across
 * versions, because approving the row approves all of them.
 */
export interface AdminStory {
  originalId: string;
  /** Every version, ascending by ageTarget. Never empty. */
  versions: AdminArticle[];
  safety: Safety;
  status: ArticleStatus;
  kidHeadline: string;
  category: string;
  sourceId: string;
  originalHeadline: string;
  createdAt: string;
}
```

`Safety` and `ArticleStatus` are exported from `web/src/lib/types.ts:14-15`.
That file's existing import line already brings in `KidArticle`; extend it
rather than adding a second import.

- [ ] **Step 4: Build StoryRow**

Create `web/src/pages/admin/review/StoryRow.tsx`:

```tsx
import { Eye, ExternalLink, Loader2, Pencil, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { CategoryBadge, SafetyBadge } from '../../../components/Badges';
import { Button } from '../../../ui/Button';
import type { AdminStory } from '../../../admin/types';
import type { PendingAction, RowActions } from './ArticleRow';

const STATUS_STYLE: Record<string, string> = {
  pending_review: 'bg-surface-sun text-amber-800',
  published: 'bg-safety-calm/15 text-safety-calm',
  rejected: 'bg-destructive/10 text-destructive',
};

const STATUS_LABEL: Record<string, string> = {
  pending_review: 'pending review',
  published: 'published',
  rejected: 'rejected',
};

/**
 * One queue row per story (§5) — a story being one raw article's age versions.
 *
 * The safety badge shows the STRICTEST verdict across those versions, because
 * every button here acts on all of them: showing age 14's 'calm' while age 5 is
 * 'skip-young' would hide exactly what the editor needs to see.
 */
export function StoryRow({
  story,
  selected,
  onSelectedChange,
  actions,
  pending = null,
  locked = false,
}: {
  story: AdminStory;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  actions: RowActions;
  pending?: PendingAction;
  locked?: boolean;
}) {
  const busy = (action: PendingAction) => pending === action;
  const spinner = <Loader2 className="w-3.5 h-3.5 animate-spin" />;
  const ages = story.versions.map((version) => version.ageTarget);

  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <input
          type="checkbox"
          className="mt-1.5"
          aria-label={`Select ${story.kidHeadline}`}
          checked={selected}
          disabled={locked}
          onChange={(event) => onSelectedChange(event.target.checked)}
        />

        <div className="min-w-0 flex-1">
          <p className="font-bold">{story.kidHeadline}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {story.originalHeadline}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full px-2.5 py-1 font-semibold ${STATUS_STYLE[story.status] ?? 'bg-muted'}`}>
              {STATUS_LABEL[story.status] ?? story.status}
            </span>
            <SafetyBadge safety={story.safety} />
            <CategoryBadge category={story.category} />
            <span className="text-muted-foreground">
              {story.versions.length} reading age{story.versions.length === 1 ? '' : 's'}
              {ages.length > 0 && ` (${Math.min(...ages)}–${Math.max(...ages)})`}
            </span>
            {story.versions.some((version) => version.editedByHuman) && (
              <span className="rounded-full bg-muted px-2.5 py-1">edited by a person</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={locked} onClick={actions.onView}>
            <Eye className="w-3.5 h-3.5" /> Read
          </Button>

          {story.status !== 'published' && (
            <Button size="sm" disabled={locked} onClick={actions.onPublish}>
              {busy('publish') ? spinner : null} Publish all
            </Button>
          )}

          {story.status === 'published' && (
            <Button size="sm" variant="outline" disabled={locked} onClick={actions.onUnpublish}>
              {busy('unpublish') ? spinner : <Undo2 className="w-3.5 h-3.5" />} Unpublish
            </Button>
          )}

          {story.status !== 'rejected' && (
            <Button size="sm" variant="outline" disabled={locked} onClick={actions.onReject}>
              {busy('reject') ? spinner : null} Reject
            </Button>
          )}

          <Button size="sm" variant="outline" disabled={locked} onClick={actions.onEdit}>
            <Pencil className="w-3.5 h-3.5" /> Edit
          </Button>

          <Button size="sm" variant="outline" disabled={locked} onClick={actions.onRegenerate}>
            {busy('regenerate') ? spinner : <RotateCcw className="w-3.5 h-3.5" />} Regenerate
          </Button>

          {story.status !== 'published' && (
            <Button size="sm" variant="outline" disabled={locked} onClick={actions.onDelete}>
              {busy('delete') ? spinner : <Trash2 className="w-3.5 h-3.5" />} Delete
            </Button>
          )}

          <a
            href={story.versions[0].sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm underline hover:no-underline"
          >
            Original <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
```

Check `web/src/components/Badges.tsx` for `SafetyBadge`'s and `CategoryBadge`'s exact prop names before running; `ArticleRow.tsx` uses both and is the reference.

- [ ] **Step 5: Switch AdminReview to stories**

In `web/src/pages/admin/AdminReview.tsx`:

Add the imports and swap the state:

```tsx
import { StoryRow } from './review/StoryRow';
import type { AdminStory } from '../../admin/types';
```

```tsx
  const [stories, setStories] = useState<AdminStory[]>([]);
```

Replace the fetch inside `load` (the non-waiting branch):

```tsx
      const listRes = await adminFetch(`/api/admin/stories${query}`);
      if (!listRes.ok) {
        throw new Error(((await listRes.json()) as { error?: string }).error ?? 'Could not load articles.');
      }
      setStories(((await listRes.json()) as { stories: AdminStory[] }).stories);
```

Every place that read `articles` now reads `stories`. The row-action calls send
`story.versions[0].id`, and the dialogs still take an `AdminArticle`, so pass
`story.versions[0]` to them — Task 4 gives `ViewArticleDialog` the whole story.

Replace the list block:

```tsx
            {stories.length === 0 ? (
              <p className="rounded-3xl border border-border bg-card px-6 py-14 text-center text-muted-foreground">
                Nothing matches these filters.
              </p>
            ) : (
              <div className="space-y-3">
                {stories.map((story) => {
                  const id = story.versions[0].id;
                  return (
                    <StoryRow
                      key={story.originalId}
                      story={story}
                      selected={selected.has(id)}
                      onSelectedChange={(isSelected) => toggleSelected(id, isSelected)}
                      pending={pending?.id === id ? pending.action : null}
                      locked={pending !== null}
                      actions={{
                        onView: () => setViewing(story),
                        onPublish: () => void runRowAction(id, 'publish',
                          `/api/admin/articles/${id}/publish`, { method: 'PATCH' }, 'Published every age version.'),
                        onReject: () => setRejecting(story.versions[0]),
                        onUnpublish: () => void runRowAction(id, 'unpublish',
                          `/api/admin/articles/${id}/unpublish`, { method: 'PATCH' }, 'Moved back to pending review.'),
                        onEdit: () => setEditing(story.versions[0]),
                        onRegenerate: () => void openRegenerate(story.versions[0]),
                        onDelete: () => setConfirming({
                          title: `Delete all ${story.versions.length} versions of this story?`,
                          body: (
                            <>
                              <strong>{story.kidHeadline}</strong> will be removed for good, at every
                              reading age. The original article stays, so it can be simplified again later.
                            </>
                          ),
                          confirmLabel: `Delete ${story.versions.length}`,
                          tone: 'danger',
                          onConfirm: () => void runRowAction(id, 'delete',
                            `/api/admin/articles/${id}`, { method: 'DELETE' }, 'Deleted every version.'),
                        }),
                      }}
                    />
                  );
                })}
              </div>
            )}
```

Update the select-all control and the flagged count to work over stories:

```tsx
  const allSelected =
    stories.length > 0 && stories.every((story) => selected.has(story.versions[0].id));
  const flaggedSelectedCount = stories.filter(
    (story) => selected.has(story.versions[0].id) && story.safety === 'skip-young',
  ).length;
```

```tsx
                  checked={allSelected}
                  disabled={stories.length === 0}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(stories.map((s) => s.versions[0].id)) : new Set())
                  }
                />
                Select all {stories.length > 0 && `(${stories.length} shown)`}
              </label>
              <span className="text-sm text-muted-foreground">{stories.length} result(s)</span>
```

Change the `viewing` state to hold a story:

```tsx
  const [viewing, setViewing] = useState<AdminStory | null>(null);
```

Task 4 updates the `ViewArticleDialog` call site to match; until then pass
`viewing.versions[0]` to it so this task compiles on its own.

- [ ] **Step 6: Run the web suite**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS. `admin-review.test.tsx`'s existing tests use one version per story, so grouping is a no-op for them — but any that assert on three separate rows of the same story, or on `/api/admin/articles` being called for the list, need updating to `/api/admin/stories`. Update the assertion, not the component.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/admin/review/StoryRow.tsx web/src/admin/types.ts \
        web/src/pages/admin/AdminReview.tsx web/src/__tests__/admin-review.test.tsx
git commit -m "feat: show one review row per story"
```

---

## Task 4: Read every version before approving

**Files:**
- Modify: `web/src/pages/admin/dialogs/ViewArticleDialog.tsx`
- Modify: `web/src/pages/admin/AdminReview.tsx` (the dialog call site)
- Test: `web/src/__tests__/admin-dialogs.test.tsx`

**Interfaces:**
- Consumes: `AdminStory` (Task 3).
- Produces: `ViewArticleDialog` takes `story: AdminStory` instead of `article: AdminArticle`, and renders one version at a time behind an age selector.

**Why this task exists:** §2.2 promises a human read every word a child sees. With ten versions per story and one Approve button, that promise is only real if the editor can actually read all ten here.

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/admin-dialogs.test.tsx`:

```tsx
describe('reading every age version before approving (§5)', () => {
  const story = {
    originalId: 'raw-1',
    versions: [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, kidHeadline: 'Headline for fives', summary: 'Summary for fives.' }),
      article({ id: 'v9', originalId: 'raw-1', ageTarget: 9, kidHeadline: 'Headline for nines', summary: 'Summary for nines.' }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14, kidHeadline: 'Headline for fourteens', summary: 'Summary for fourteens.' }),
    ],
    safety: 'calm',
    status: 'pending_review',
    kidHeadline: 'Headline for fives',
    category: 'World',
    sourceId: 'bbc',
    originalHeadline: 'Adult headline',
    createdAt: '2026-09-04T10:00:00.000Z',
  };

  const open = () =>
    render(
      <ViewArticleDialog
        story={story as never}
        onClose={() => {}}
        onEdit={() => {}}
        onPublish={() => {}}
        onReject={() => {}}
      />,
    );

  it('opens on the youngest version', () => {
    open();
    expect(screen.getByText('Headline for fives')).toBeInTheDocument();
  });

  it('offers every age and switches the text', async () => {
    const user = userEvent.setup();
    open();

    for (const age of [5, 9, 14]) {
      expect(screen.getByRole('button', { name: `Age ${age}` })).toBeInTheDocument();
    }

    await user.click(screen.getByRole('button', { name: 'Age 14' }));

    expect(screen.getByText('Headline for fourteens')).toBeInTheDocument();
    expect(screen.getByText('Summary for fourteens.')).toBeInTheDocument();
    expect(screen.queryByText('Headline for fives')).not.toBeInTheDocument();
  });

  it('says how many versions Publish will approve', () => {
    open();
    expect(screen.getByRole('button', { name: /publish all 3/i })).toBeInTheDocument();
  });
});
```

Match the file's existing `article()` helper and render wrapper; read the top of `admin-dialogs.test.tsx` and reuse them rather than adding a second style.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/admin-dialogs.test.tsx`
Expected: FAIL — the dialog takes `article`, not `story`, so nothing renders.

- [ ] **Step 3: Give the dialog an age selector**

In `web/src/pages/admin/dialogs/ViewArticleDialog.tsx`, change the signature and add the selector. Keep the existing body markup, reading from `version` instead of `article`:

```tsx
export function ViewArticleDialog({
  story,
  onClose,
  onEdit,
  onPublish,
  onReject,
}: {
  story: AdminStory;
  onClose: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onReject: () => void;
}) {
  // Opens on the youngest version: it is the strictest reading level and the
  // one most likely to need a second look.
  const [ageTarget, setAgeTarget] = useState(story.versions[0].ageTarget);
  const version =
    story.versions.find((candidate) => candidate.ageTarget === ageTarget) ?? story.versions[0];

  return (
    <Modal title="Read before deciding" onClose={onClose} wide>
      {/* §2.2 promises a human read every word a child sees. One Approve
          button covers every age, so every age has to be readable here. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-semibold text-muted-foreground">Reading age</span>
        {story.versions.map((candidate) => (
          <button
            key={candidate.id}
            onClick={() => setAgeTarget(candidate.ageTarget)}
            aria-current={candidate.ageTarget === ageTarget ? 'true' : undefined}
            className={`rounded-full px-3 py-1 text-xs font-bold transition ${
              candidate.ageTarget === ageTarget
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground/70 hover:bg-muted/70'
            }`}
          >
            Age {candidate.ageTarget}
          </button>
        ))}
      </div>
      {/* ...the existing body, with the references below repointed... */}
```

Add `useState` to the React import and swap `AdminArticle` for `AdminStory` in
the types import. The body has exactly **ten** `article.` references across
seven fields; repoint every one to `version.`:

| reference | occurrences | note |
|---|---|---|
| `article.status` | 2 | identical across versions (story-scoped), so reading it off the selected version is correct |
| `article.rejectReason` | 1 | likewise |
| `article.sourceName` | 1 | likewise |
| `article.sourceUrl` | 1 | likewise |
| `article.originalHeadline` | 1 | likewise |
| `article.readingMinutes` | 1 | genuinely per-version — must follow the selector |
| `article.editedByHuman` | 1 | genuinely per-version |

Plus the line that actually makes the selector work — the preview the editor reads:

```tsx
        <StoryPreview article={version} showSource={false} headingLevel="h2" />
```

and the Publish button's label, so it names what it will approve:

```tsx
        {version.status !== 'published' && (
          <Button size="lg" onClick={onPublish}>Publish all {story.versions.length}</Button>
        )}
```

Verify with `grep -c 'article\.' web/src/pages/admin/dialogs/ViewArticleDialog.tsx` —
it must report 0 when the rename is complete.

- [ ] **Step 4: Update the call site**

In `web/src/pages/admin/AdminReview.tsx`, pass the story:

```tsx
      {viewing && (
        <ViewArticleDialog
          story={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing.versions[0]); setViewing(null); }}
          onReject={() => { setRejecting(viewing.versions[0]); setViewing(null); }}
          onPublish={() => {
            const id = viewing.versions[0].id;
            setViewing(null);
            void runRowAction(id, 'publish', `/api/admin/articles/${id}/publish`, { method: 'PATCH' },
              'Published every age version.');
          }}
        />
      )}
```

- [ ] **Step 5: Run the web suite**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS. Other suites that render `ViewArticleDialog` with an `article` prop will fail to typecheck — update them to pass a one-version story, which is what a single-version article now is.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/dialogs/ViewArticleDialog.tsx web/src/pages/admin/AdminReview.tsx \
        web/src/__tests__/admin-dialogs.test.tsx
git commit -m "feat: let an editor read every age version before approving"
```

---

## Task 5: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the grouped queue and the action scope**

In the "One version per reading age" section, replace the sentence
"The review queue therefore shows the engine per version." with:

```markdown
The review queue therefore shows the engine per version.

**The queue is grouped by story.** One row covers all ten versions, and its
safety badge shows the strictest verdict across them — a story that is
`skip-young` at age 5 never presents as `calm` because age 14 is. **Read**
opens every version behind an age selector, because §2.2 promises a human read
every word a child sees and one Approve covers all ten.

Publish, reject, unpublish and delete are **story-scoped**: they take any one
version's id and apply to every version of that story, so a story's versions
always share one status. The endpoint URLs are unchanged from when a story had
one version — `PATCH /api/admin/articles/:id/publish` now publishes the story
that id belongs to. **Edit is the exception** and stays per-version, so one
age's wording can be fixed without touching the other nine.

Bulk approve still excludes `skip-young` unless you opt in, and that check uses
the story's strictest version — selecting a calm age-14 row cannot publish a
skip-young age-5 one.
```

- [ ] **Step 2: Update the admin route table**

The `/admin/review` row of the pages table describes reviewing articles. Change
its description to name the grouping:

```markdown
| `/admin/review`   | Approve, reject or edit stories — one row per story, all ages together   |
```

Read the table first and match its column widths.

- [ ] **Step 3: Verify**

Run: `cd server && npm test && npm run typecheck && cd ../web && npm test && npm run typecheck`
Expected: PASS everywhere. Then re-read the new README text against
`articleActions.ts` and `articleBulk.ts` and confirm the scope claims are true.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe the story-grouped review queue"
```

---

## Done-when

- `/admin/review` shows one row per story, whatever the version count, and the badge reads "10 reading ages (5–14)".
- The row's safety badge is the strictest across versions; a story that is `skip-young` at any age shows `skip-young`.
- Publish, reject, unpublish and delete each affect every version of the story, and only that story.
- Every published version carries a `publishedAt`, satisfying the schema CHECK.
- Delete is refused for a published story with a 409.
- Edit changes one version and sets `editedByHuman` on that version only.
- Bulk approve skips a story whose strictest version is `skip-young` unless `includeFlagged` is set, and counts a story once however many of its versions were selected.
- Tab counts show stories, not versions.
- **Read** offers every age and switches the text; Publish names the version count.
- `cd server && npm test && npm run typecheck` and `cd web && npm test && npm run typecheck` all pass.

## Not in this phase

- The public slider still does nothing. Phase 3.
- Regenerate stays per-version: it regenerates the youngest version only. Whether
  it should regenerate all ten is a real question, deliberately deferred.
