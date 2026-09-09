# Per-Age Versions — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moving the reading-age slider changes the story text a reader gets, instead of only relabelling one version.

**Architecture:** `GET /api/articles?age=N` returns one entry per story — the version for age N, or the nearest published one — picked with a SQLite window function that partitions by `originalId` and orders by `ABS(ageTarget - N)`. `GET /api/articles/:id?age=N` resolves the id to its story and applies the same rule, so the slider keeps working one click deeper. The response carries `ageMatched`, and the web pages pass `readingAge` and refetch when it changes.

**Tech Stack:** Node.js 20+, TypeScript (ESM, `.js` import specifiers), better-sqlite3 (SQLite 3.49.2, window functions need 3.25+), Express 4, Vitest; React 18 + Vite + Tailwind + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-09-per-age-versions-design.md` (Phase 3 is §6; Phases 0–2 have shipped)

## Global Constraints

- Ages are `MIN_AGE = 5` to `MAX_AGE = 14`, from `server/src/core/article.ts` and `web/src/settings/SettingsContext.tsx`. Never hardcode 5 or 14.
- **Published only.** The public repository reads hardcode `status = 'published'` in SQL rather than accepting it as an argument — Phase 0 established this after finding the endpoint serving 20 unreviewed articles. Do not add a status parameter back, at any level.
- **`age` is validated, never interpolated.** Bind it as a parameter. An absent, non-numeric or out-of-range `age` falls back to `app_settings.defaultAge` rather than erroring: this is a public read path for a children's site, and robustness beats strictness.
- **Ties prefer the younger version.** Age 9 with versions 8 and 10 available gets 8. Reading down is safer than reading up for a children's product, and the `ageTarget` tie-break in the ORDER BY is what makes it deterministic.
- **One entry per story, never ten.** A story with no published version at any age is absent entirely.
- `ageMatched` is a response-only field. It is not stored on `kid_articles`.
- Column names verbatim from the PRD's interfaces; `.js` extensions on every local import.
- Server tests: `cd server && npm test`. Web tests: `cd web && npm test`. Typecheck both.
- One-line commit messages, no body, no `Co-Authored-By` trailer.

---

## File Structure

**Modified:**

| File | Change |
|---|---|
| `server/src/db/repositories/articleRepository.ts` | `listPublishedForAge`, `findPublishedForAge` |
| `server/src/routes/public/articles.ts` | `?age=N`, fallback to `defaultAge`, `ageMatched` in the response |
| `web/src/lib/types.ts` | `PublicArticle` |
| `web/src/lib/api.ts` | `fetchPublishedArticles(age)`, `fetchArticle(id, age)` |
| `web/src/pages/Home.tsx` | Pass `readingAge`, refetch on change, fix the stale comment |
| `web/src/pages/Podcast.tsx` | Pass `readingAge`, refetch on change |
| `web/src/pages/Settings.tsx` | Pass `readingAge`; say the slider changes the stories |
| `web/src/components/StoryCard.tsx` | The out-of-band note |
| `web/src/components/StoryPreview.tsx` | The out-of-band note |
| `README.md` | The slider section |

**Tests:** `server/tests/public-api.test.ts`, `web/src/__tests__/public-pages.test.tsx`

---

## Task 1: Nearest-age reads in the repository

**Files:**
- Modify: `server/src/db/repositories/articleRepository.ts`
- Test: `server/tests/public-api.test.ts`

**Interfaces:**
- Consumes: the existing `toKidArticle` and `KidArticleRow`.
- Produces:
  ```ts
  /** A published story as a reader gets it, plus whether the age was an exact hit. */
  export interface PublicArticle extends KidArticle {
    /** False when the reader's age had no version and a nearer one was served. */
    ageMatched: boolean;
  }
  listPublishedForAge(age: number): PublicArticle[]
  findPublishedForAge(id: string, age: number): PublicArticle | undefined
  ```
  `listPublished()` and `findPublishedById()` stay: the age-less reads are still
  the right thing for a caller that has no reader in front of it, and removing
  them would churn Phase 0's tests for nothing.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/public-api.test.ts`. This file's `beforeAll` seeds
single-version stories; these tests add multi-version ones of their own:

```ts
describe('one version per reading age (§6)', () => {
  /** A published story with one version per given age. */
  const seedStory = (rawId: string, ages: number[]) => {
    const raw = insertRawArticle(ctx.db, {
      id: rawId, headline: `Adult headline ${rawId}`, simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    for (const age of ages) {
      insertKidArticle(ctx.db, {
        id: `${rawId}-v${age}`, originalId: raw, ageTarget: age, status: 'published',
        kidHeadline: `Written for age ${age}`, createdAt: '2026-09-07T10:00:00.000Z',
      });
    }
    return raw;
  };

  const storyFrom = (rows: any[], rawId: string) =>
    rows.filter((a) => a.originalId === rawId);

  it('serves the version matching the requested age', async () => {
    const raw = seedStory('ages-all', [5, 6, 7, 8]);

    const rows = await (await ctx.anon('/api/articles?age=7')).json();
    const mine = storyFrom(rows, raw);

    // One entry for the story, not four.
    expect(mine).toHaveLength(1);
    expect(mine[0].kidHeadline).toBe('Written for age 7');
    expect(mine[0].ageTarget).toBe(7);
    expect(mine[0].ageMatched).toBe(true);
  });

  it('serves the nearest published version when the age has none', async () => {
    const raw = seedStory('ages-gap', [5, 12]);

    const rows = await (await ctx.anon('/api/articles?age=11')).json();
    const mine = storyFrom(rows, raw);

    expect(mine[0].ageTarget).toBe(12);
    // Flagged, so the UI can say it was written for a different age.
    expect(mine[0].ageMatched).toBe(false);
  });

  it('prefers the younger version on a tie', async () => {
    // Age 9 sits exactly between 8 and 10. Reading down is the safer default
    // for a children's product, so 8 wins.
    const raw = seedStory('ages-tie', [8, 10]);

    const rows = await (await ctx.anon('/api/articles?age=9')).json();

    expect(storyFrom(rows, raw)[0].ageTarget).toBe(8);
  });

  it('never serves an unpublished version, even when it is the closest age', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'ages-unpub', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, {
      id: 'ages-unpub-v9', originalId: raw, ageTarget: 9, status: 'pending_review',
      kidHeadline: 'Unreviewed age 9',
    });
    insertKidArticle(ctx.db, {
      id: 'ages-unpub-v5', originalId: raw, ageTarget: 5, status: 'published',
      kidHeadline: 'Published age 5',
    });

    const rows = await (await ctx.anon('/api/articles?age=9')).json();
    const mine = storyFrom(rows, raw);

    // Age 9 is the exact match but is unreviewed (§2.2), so age 5 is served.
    expect(mine[0].kidHeadline).toBe('Published age 5');
    expect(mine[0].ageMatched).toBe(false);
  });

  it('omits a story with no published version at any age', async () => {
    const raw = insertRawArticle(ctx.db, {
      id: 'ages-none', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, { id: 'ages-none-v5', originalId: raw, ageTarget: 5, status: 'pending_review' });
    insertKidArticle(ctx.db, { id: 'ages-none-v6', originalId: raw, ageTarget: 6, status: 'rejected' });

    const rows = await (await ctx.anon('/api/articles?age=5')).json();

    expect(storyFrom(rows, raw)).toHaveLength(0);
  });

  it.each([['?age=99'], ['?age=abc'], ['?age=-3'], ['?age='], ['']])(
    'falls back to the default age for %s rather than erroring',
    async (query) => {
      const res = await ctx.anon(`/api/articles${query}`);

      // A public read path for a children's site answers, rather than 400ing
      // because a query string was odd.
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    },
  );

  it('serves a single-version story to every age', async () => {
    // The stories that existed before this feature have one version each, and
    // must not vanish from the feed as the slider moves.
    const raw = seedStory('ages-one', [8]);

    for (const age of [5, 8, 14]) {
      const rows = await (await ctx.anon(`/api/articles?age=${age}`)).json();
      expect(storyFrom(rows, raw)).toHaveLength(1);
    }
  });
});

describe('GET /api/articles/:id?age= (§6)', () => {
  it('serves the sibling version for the requested age', async () => {
    // The slider has to keep working when a reader is already on a story page:
    // the id names one version, but the reader wants that STORY at their age.
    const raw = insertRawArticle(ctx.db, {
      id: 'detail-raw', simplifiedAt: '2026-09-06T09:00:00.000Z',
    });
    insertKidArticle(ctx.db, {
      id: 'detail-v5', originalId: raw, ageTarget: 5, status: 'published',
      kidHeadline: 'Written for age 5',
    });
    insertKidArticle(ctx.db, {
      id: 'detail-v14', originalId: raw, ageTarget: 14, status: 'published',
      kidHeadline: 'Written for age 14',
    });

    const article = await (await ctx.anon('/api/articles/detail-v5?age=14')).json();

    expect(article.kidHeadline).toBe('Written for age 14');
    expect(article.ageMatched).toBe(true);
  });

  it('still 404s for an unpublished story', async () => {
    expect((await ctx.anon('/api/articles/pending-1?age=8')).status).toBe(404);
  });

  it('still 404s for an unknown id', async () => {
    expect((await ctx.anon('/api/articles/nope?age=8')).status).toBe(404);
  });
});
```

Add `insertKidArticle` and `insertRawArticle` to this file's import from
`./helpers.js`; it currently imports only `createTestContext`,
`insertKidArticle` and `TestContext`, so check and extend rather than
duplicating the line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/public-api.test.ts`
Expected: FAIL — `ageMatched` is undefined, and a four-version story returns four entries because `?age=` is ignored.

- [ ] **Step 3: Add the repository reads**

In `server/src/db/repositories/articleRepository.ts`, add the type beneath
`AdminStory`:

```ts
/**
 * A published story as a reader gets it: one version, chosen for their reading
 * age. `ageMatched` is response-only and is never stored.
 */
export interface PublicArticle extends KidArticle {
  /** False when the reader's age had no version and a nearer one was served. */
  ageMatched: boolean;
}
```

Add the statements. The window function picks one row per story:

```ts
    // §6: one row per story — the version for @age, else the nearest published.
    // ABS() finds the nearest; the ageTarget tie-break makes a tie prefer the
    // YOUNGER version, because reading down is safer than reading up for a
    // children's product. Window functions need SQLite 3.25+; the pinned
    // better-sqlite3 reports 3.49.2.
    publishedForAge: db.prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY originalId ORDER BY ABS(ageTarget - @age), ageTarget
         ) AS rn
         FROM kid_articles WHERE status = 'published'
       ) WHERE rn = 1 ORDER BY createdAt DESC`,
    ),
    // The same rule inside ONE story, resolved from any of its version ids, so
    // the slider keeps working on a story page.
    publishedForAgeById: db.prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY originalId ORDER BY ABS(ageTarget - @age), ageTarget
         ) AS rn
         FROM kid_articles
         WHERE status = 'published'
           AND originalId = (SELECT originalId FROM kid_articles WHERE id = @id)
       ) WHERE rn = 1`,
    ),
```

Add to the interface, beside the Phase 0 reads:

```ts
  /** §6: one published version per story, chosen for the reader's age. */
  listPublishedForAge(age: number): PublicArticle[];
  findPublishedForAge(id: string, age: number): PublicArticle | undefined;
```

and the implementations:

```ts
    listPublishedForAge(age) {
      return (statements.publishedForAge.all({ age }) as KidArticleRow[])
        .map((row) => withAgeMatch(toKidArticle(row), age));
    },

    findPublishedForAge(id, age) {
      const row = statements.publishedForAgeById.get({ id, age }) as KidArticleRow | undefined;
      return row ? withAgeMatch(toKidArticle(row), age) : undefined;
    },
```

Add the helper above `createArticleRepository`:

```ts
/** Tags a served version with whether it was an exact match for the reader. */
const withAgeMatch = (article: KidArticle, age: number): PublicArticle => ({
  ...article,
  ageMatched: article.ageTarget === age,
});
```

The subquery's `SELECT *` adds an `rn` column to each row; `toKidArticle` reads
named fields and ignores it, so nothing needs stripping.

- [ ] **Step 4: Add `?age=` to the public routes**

Rewrite the two handlers in `server/src/routes/public/articles.ts`:

```ts
import { MAX_AGE, MIN_AGE } from '../../core/article.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';
```

```ts
export function createArticlesRouter(db: Database): Router {
  const router = Router();
  const articles = createArticleRepository(db);
  const settings = createSettingsRepository(db);

  /**
   * The reader's age, or the configured default.
   *
   * An absent, non-numeric or out-of-range value falls back rather than
   * erroring: this is the read path a child's browser hits, and answering with
   * the default beats a 400 because a query string was odd. Bound as a
   * parameter by the repository, never interpolated.
   */
  const readAge = (raw: unknown): number => {
    const age = Number(raw);
    const usable = Number.isInteger(age) && age >= MIN_AGE && age <= MAX_AGE;
    return usable ? age : settings.getAppSettings().defaultAge;
  };

  /**
   * GET /api/articles[?age=N] -> PublicArticle[], newest first, published only.
   * One entry per story: the version for age N, or the nearest published one.
   */
  router.get('/articles', (req, res) => {
    res.json(articles.listPublishedForAge(readAge(req.query.age)));
  });

  /**
   * 404, not 403, for an unpublished story: a 403 would confirm it exists and
   * let someone enumerate what is sitting unreviewed in the queue.
   *
   * The id names one version; the reader gets that STORY at their age, so the
   * slider keeps working after they have opened something.
   */
  router.get('/articles/:id', (req, res) => {
    const article = articles.findPublishedForAge(req.params.id, readAge(req.query.age));
    if (!article) throw NotFoundError.of('article', req.params.id);
    res.json(article);
  });

  return router;
}
```

Update the module comment's first paragraph to mention the age selection:

```ts
/**
 * Public article routes (PRD §3). Read-only: no auth, no mutations.
 *
 * One entry per story, at the reader's reading age (§3.6, §6): a story exists
 * in one version per age, and `?age=N` picks the version for N or the nearest
 * published one.
 *
 * Published stories ONLY, and not because the caller asked nicely — the
 * repository methods used here hardcode the status. This endpoint is what a
 * child's browser reaches, and §2.2 promises a human read every word first, so
 * a `status` query parameter used to make that promise depend on the caller.
 */
```

- [ ] **Step 5: Run the whole suite**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. Phase 0's tests assert `/api/articles` returns 3 published rows from single-version fixtures; those stories have one version each, so the nearest-age rule returns the same 3. If a count changed, a fixture has two versions of one story and the new number is correct — check before editing.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/repositories/articleRepository.ts server/src/routes/public/articles.ts \
        server/tests/public-api.test.ts
git commit -m "feat: serve each story at the reader's reading age"
```

---

## Task 2: The slider drives the feed

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/pages/Home.tsx`
- Modify: `web/src/pages/Podcast.tsx`
- Modify: `web/src/pages/Settings.tsx`
- Test: `web/src/__tests__/public-pages.test.tsx`

**Interfaces:**
- Consumes: `?age=` on both public endpoints (Task 1).
- Produces:
  ```ts
  export interface PublicArticle extends KidArticle { ageMatched: boolean }
  fetchPublishedArticles(age: number): Promise<PublicArticle[]>
  fetchArticle(id: string, age: number): Promise<PublicArticle>
  ```

**The stale comment to fix:** `Home.tsx:26-27` currently reads *"Source toggles
(§3.6) filter the feed; the reading-age slider does not — it drives the badge
and the default age for new simplifications (§11.1)."* That documents exactly
the behaviour this task reverses, so it must change with the code.

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/public-pages.test.tsx`. The file's existing
`mockFetch(payload)` returns the same body for every request, so these tests
need a stub that varies by URL. The helpers to reuse are `article(overrides)`
for the fixture and `renderIn(ui)` for the render wrapper (which already wraps
in `MemoryRouter` and `SettingsProvider`). `Home` is not imported in this file
yet — add it:

```tsx
import { Home } from '../pages/Home';
```

`safety.test.tsx` and `prototype-parity.test.tsx` already render `Home`, so the
hero-image import resolves fine under Vitest.

```tsx
describe('the reading-age slider changes the story (§6)', () => {
  /** Serves a different headline per requested age, so a change is visible. */
  function mockByAge() {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url);
      requested.push(path);
      const age = new URL(path, 'http://x').searchParams.get('age') ?? 'none';
      return {
        ok: true,
        status: 200,
        json: async () => [{
          ...article({
            id: `a-${age}`,
            ageTarget: Number(age),
            kidHeadline: `Written for age ${age}`,
          }),
          ageMatched: true,
        }],
      } as unknown as Response;
    }));
    return { requested };
  }

  afterEach(() => vi.unstubAllGlobals());

  /** The stored shape SettingsProvider reads on mount. */
  const storeAge = (readingAge: number) =>
    window.localStorage.setItem(
      'news4littles.settings',
      JSON.stringify({ readingAge, disabledSources: [] }),
    );

  it('asks the API for the reader’s age', async () => {
    const { requested } = mockByAge();
    storeAge(11);

    renderIn(<Home />);

    await waitFor(() => expect(requested.some((p) => p.includes('age=11'))).toBe(true));
  });

  it('shows the story written for that age', async () => {
    mockByAge();
    storeAge(11);

    renderIn(<Home />);

    expect(await screen.findByText('Written for age 11')).toBeInTheDocument();
  });

  it('refetches when the reader moves the slider', async () => {
    const { requested } = mockByAge();
    const user = userEvent.setup();
    storeAge(6);

    renderIn(<Settings />);

    // A range input moves on arrow keys, which is also how a reader using a
    // keyboard or assistive tech would move it.
    const slider = await screen.findByLabelText('Default reading age');
    slider.focus();
    await user.keyboard('{ArrowRight}');

    await waitFor(() => expect(requested.some((p) => p.includes('age=7'))).toBe(true));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/public-pages.test.tsx`
Expected: FAIL — no request contains `age=11`, because `fetchPublishedArticles` sends `?status=published`.

- [ ] **Step 3: Add the web type**

In `web/src/lib/types.ts`, beneath `KidArticle`:

```ts
/**
 * A published story as the public API serves it: one version, chosen for the
 * reader's age. `ageMatched` is false when their age had no version and a
 * nearer one was served, so the UI can say so rather than implying a match.
 */
export interface PublicArticle extends KidArticle {
  ageMatched: boolean;
}
```

- [ ] **Step 4: Send the age from the API client**

In `web/src/lib/api.ts`:

```ts
import type { PublicArticle } from './types';
```

```ts
/**
 * Home, the podcast page and Settings show published stories only (PRD §11.1),
 * one per story at the reader's reading age (§3.6).
 */
export function fetchPublishedArticles(age: number): Promise<PublicArticle[]> {
  return getJson<PublicArticle[]>(`/api/articles?age=${encodeURIComponent(age)}`);
}

/** The id names one version; the reader gets that story at their age. */
export function fetchArticle(id: string, age: number): Promise<PublicArticle> {
  return getJson<PublicArticle>(
    `/api/articles/${encodeURIComponent(id)}?age=${encodeURIComponent(age)}`,
  );
}
```

The `KidArticle` import may become unused — check and remove it if so.

- [ ] **Step 5: Pass the age from every page**

`web/src/pages/Home.tsx` — replace the fetch and the stale comment:

```tsx
  const state = useAsync(() => fetchPublishedArticles(readingAge), [readingAge]);
```

```tsx
  // Source toggles (§3.6) filter the feed. The reading-age slider changes the
  // TEXT: a story exists in one version per age, and the API serves the version
  // for this reader (§6), so moving the slider refetches rather than relabels.
```

`web/src/pages/Podcast.tsx` — the page needs the hook:

```tsx
import { useSettings } from '../settings/SettingsContext';
```

```tsx
  const { readingAge } = useSettings();
  const state = useAsync(() => fetchPublishedArticles(readingAge), [readingAge]);
```

Check whether `Podcast` already calls `useSettings` for source toggles before
adding the import; if it does, destructure `readingAge` from the existing call.

`web/src/pages/Settings.tsx` — it already has `readingAge`:

```tsx
  const state = useAsync(() => fetchPublishedArticles(readingAge), [readingAge]);
```

`web/src/pages/StoryDetail.tsx` — the slider must keep working one click deeper:

```tsx
import { useSettings } from '../settings/SettingsContext';
```

```tsx
  const { id = '' } = useParams();
  const { readingAge } = useSettings();
  const state = useAsync(() => fetchArticle(id, readingAge), [id, readingAge]);
```

- [ ] **Step 6: Say what the slider does**

In `web/src/pages/Settings.tsx`, the panel's only explanation is the page-level
"Choose a reading age and which news sources appear." Add a line under the
slider's tick marks so the control explains itself:

```tsx
        <p className="mt-3 text-sm text-muted-foreground">
          Every story is rewritten for each age, so moving this changes the words —
          shorter sentences and simpler words for younger readers.
        </p>
```

- [ ] **Step 7: Run the web suite**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS. `safety.test.tsx` and `prototype-parity.test.tsx` both render
`Home` with their own fetch stubs; those stubs ignore the URL, so they should
keep working. Any test that asserts on `?status=published` needs updating to the
age-based URL — that is the deliberate change. Update the assertion, not the
code.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/api.ts web/src/pages/Home.tsx \
        web/src/pages/Podcast.tsx web/src/pages/Settings.tsx web/src/pages/StoryDetail.tsx \
        web/src/__tests__/public-pages.test.tsx
git commit -m "feat: let the reading-age slider choose the story text"
```

---

## Task 3: Say when a story is out of band

**Files:**
- Modify: `web/src/components/StoryCard.tsx`
- Modify: `web/src/components/StoryPreview.tsx`
- Test: `web/src/__tests__/public-pages.test.tsx`

**Interfaces:**
- Consumes: `PublicArticle.ageMatched` (Task 2).
- Produces: no new exports. Both components accept `KidArticle` today; they gain
  an optional `ageMatched?: boolean`, so an admin caller passing a plain
  `AdminArticle` keeps working and simply shows no note.

**Why:** §6 chose "nearest published band, **labelled**". Without the label a
parent has no way to tell they are reading a version written for a different
age, which is the whole reason that option was picked over the unlabelled one.

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/public-pages.test.tsx`:

```tsx
describe('the out-of-band note (§6)', () => {
  it('says so when the served version was written for another age', () => {
    renderIn(<StoryCard article={{ ...article({ ageTarget: 12 }), ageMatched: false }} />);

    expect(screen.getByText(/written for age 12/i)).toBeInTheDocument();
  });

  it('stays quiet when the age matched', () => {
    renderIn(<StoryCard article={{ ...article({ ageTarget: 8 }), ageMatched: true }} />);

    expect(screen.queryByText(/written for age/i)).not.toBeInTheDocument();
  });

  it('stays quiet when nothing said either way', () => {
    // The admin queue renders these components with an AdminArticle, which has
    // no ageMatched. Absence must not read as "out of band".
    renderIn(<StoryCard article={article()} />);

    expect(screen.queryByText(/written for age/i)).not.toBeInTheDocument();
  });
});
```

`StoryCard` and `renderIn` are both already imported in this file; `article()`
is its fixture factory.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/public-pages.test.tsx`
Expected: FAIL — no element matching `/written for age 12/i`.

- [ ] **Step 3: Add the note to StoryCard**

In `web/src/components/StoryCard.tsx`, widen the prop type. The component's
signature is currently `function StoryCard({ article }: { article: KidArticle })`:

```tsx
export function StoryCard({
  article,
}: {
  /**
   * `ageMatched` comes from the public API (§6). It is optional because the
   * admin queue renders this with an AdminArticle, which has no such field —
   * and absence must not read as "out of band".
   */
  article: KidArticle & { ageMatched?: boolean };
}) {
```

Then add the note directly after the badge row, above the headline, so a reader
sees it before they start reading:

```tsx
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <CategoryBadge category={article.category} />
        <SafetyBadge safety={article.safety} />
      </div>

      {article.ageMatched === false && (
        <p className="mb-2 text-xs text-muted-foreground">
          Written for age {article.ageTarget} — the closest version we have for this story.
        </p>
      )}
```

- [ ] **Step 4: Add the same note to StoryPreview**

In `web/src/components/StoryPreview.tsx`, widen its `article` prop the same way
and add the note near the top of the story, above the summary:

```tsx
  article: KidArticle & { ageMatched?: boolean };
```

```tsx
      {article.ageMatched === false && (
        <p className="mb-3 text-sm text-muted-foreground">
          Written for age {article.ageTarget} — the closest version we have for this story.
        </p>
      )}
```

- [ ] **Step 5: Run the web suite**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/StoryCard.tsx web/src/components/StoryPreview.tsx \
        web/src/__tests__/public-pages.test.tsx
git commit -m "feat: say when a story was written for a different age"
```

---

## Task 4: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Describe what the slider now does**

In the "One version per reading age" section, after the paragraph about tab
counts, add:

```markdown
**The slider on `/settings` picks the text.** `GET /api/articles?age=N` returns
one entry per story — the version written for age N, or the nearest published
one — chosen with a window function that partitions by `originalId` and orders
by `ABS(ageTarget - N)`. A tie prefers the **younger** version: age 9 with
versions 8 and 10 available gets 8, because reading down is safer than reading
up. `GET /api/articles/:id?age=N` applies the same rule inside one story, so
the slider keeps working after a reader has opened something.

An absent, non-numeric or out-of-range `age` falls back to
`app_settings.defaultAge` rather than erroring — this is the path a child's
browser hits, and answering beats a 400 because a query string was odd. The
status filter stays hardcoded regardless.

When the reader's age has no version, the response says `ageMatched: false` and
the card and story page both say "Written for age N — the closest version we
have for this story", so a parent is never shown an out-of-band version as if
it were age-matched.

Stories that predate this feature have one version each and are served to every
age by the same nearest-age rule, so they never vanish from the feed.
```

- [ ] **Step 2: Fix the pipeline diagram's last line**

The diagram's published branch ends `published → the site`. Make the age
selection visible, keeping the box-drawing alignment:

```
                                │                        published → the site
                                │                          (at the reader's age)
```

- [ ] **Step 3: Verify**

Run: `cd server && npm test && npm run typecheck && cd ../web && npm test && npm run typecheck`
Expected: PASS everywhere. Then re-read the new README text against
`articleRepository.ts`'s `publishedForAge` statement and confirm the tie-break
and fallback claims are true.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: explain how the reading-age slider picks a story"
```

---

## Done-when

- `GET /api/articles?age=7` returns one entry per story, at age 7 where a version exists.
- A story with versions 5 and 12 serves 12 to a reader at age 11, with `ageMatched: false`.
- A tie prefers the younger version: versions 8 and 10 serve 8 at age 9.
- An unpublished version is never served, even when it is the exact age.
- A story with no published version is absent from the feed entirely.
- `?age=99`, `?age=abc`, `?age=-3`, `?age=` and no parameter all answer 200 using the default age.
- `GET /api/articles/:id?age=N` serves that story's version for age N.
- Moving the slider refetches, and the story text changes.
- Out-of-band versions carry a visible note on both the card and the story page; matched ones do not, and an admin caller with no `ageMatched` shows nothing.
- `cd server && npm test && npm run typecheck` and `cd web && npm test && npm run typecheck` all pass.

## Not in this phase

- Letting a reader pick a version other than their age.
- Re-simplifying the pre-existing single-version stories into ten versions each.
- Per-age images or audio.
