# Per-Age Versions — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every simplified story gets one version per reading age, 5 to 14, stored as ten `kid_articles` rows sharing an `originalId`.

**Architecture:** `simplifyArticle` keeps its one-article-one-age signature untouched. A new `simplifyArticleForAllAges` loops ages 5–14 and calls it once per age, so each age uses its own prompt via the existing `selectPrompt`. The §6.2 prompt guard is hoisted out of the loop and injected, so it costs one call per story rather than ten. All ten versions and the `simplifiedAt` claim commit in a single transaction. The rule-based fallback changes from three age bands to `age * 2` words per sentence, so the slider is honest even when the LLM is unavailable.

**Tech Stack:** Node.js 20+, TypeScript (ESM, `.js` import specifiers), better-sqlite3 with raw SQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-per-age-versions-design.md` (Phase 1 is §4; Phases 2 and 3 are separate plans)

## Global Constraints

- Ages are `MIN_AGE = 5` to `MAX_AGE = 14` inclusive, from `server/src/core/article.ts`. Never hardcode 5 or 14.
- **Never auto-publish.** Every version is inserted `status: 'pending_review'`, `publishedAt: null` (§5.2 step 7, §2.2).
- `simplifyArticle` stays the single entry point for one raw article at one age — the sandbox (§7.4) and Regenerate depend on it, and §7.4 requires the sandbox to run production's code path.
- Column names are verbatim from the PRD's TypeScript interfaces. Table names snake_case, columns camelCase.
- Every local import uses a `.js` extension, even from `.ts`.
- `LLM_MAX_TOKENS` stays **1500**. Each call returns one version; nothing needs raising.
- All ten versions of a story commit in **one transaction** — a story holding four of ten versions cannot be reviewed or published coherently.
- The prompt guard runs **once per story**, never once per age.
- Server tests: `cd server && npm test`. Typecheck: `npm run typecheck`.
- One-line commit messages, no body, no `Co-Authored-By` trailer.

---

## File Structure

**Modified:**

| File | Change |
|---|---|
| `server/src/pipeline/simplify.ts` | `maxWordsForAge` becomes `age * 2` |
| `server/src/pipeline/simplifyArticle.ts` | `SimplifyOptions.promptGuard` injection point; new `simplifyArticleForAllAges` |
| `server/src/services/simplifyService.ts` | Store ten versions per story in one transaction |
| `server/src/db/schema.sql` | `scrape_runs.versions` |
| `server/src/db/init.ts` | `SCHEMA_VERSION` 4 and the new column |
| `server/src/db/repositories/scrapeRunRepository.ts` | Record the version count |
| `server/src/ingestion/rssScraper.ts` | `ScrapeResult.versionsCreated` |
| `server/src/services/scrapeService.ts` | Total versions in `summarise` |
| `server/src/ingestion/scheduler.ts` | Log versions |
| `server/scripts/scrape.ts` | Report versions |
| `web/src/pages/admin/settings/AppSettingsSection.tsx` | Say a budget of 10 means 100 model calls |
| `web/src/pages/admin/settings/types.ts` | `ScrapeRun.versions` |
| `README.md` | Per-age versions section |

**Tests:** `server/tests/pipeline.test.ts`, `server/tests/simplify-service.test.ts`, `server/tests/ingestion.test.ts`, `server/tests/db.test.ts`, `web/src/__tests__/admin-step7.test.tsx`

---

## Task 1: Per-age sentence limits in the rule-based fallback

**Files:**
- Modify: `server/src/pipeline/simplify.ts:9-13`
- Test: `server/tests/pipeline.test.ts:80-84`

**Interfaces:**
- Consumes: nothing.
- Produces: `maxWordsForAge(ageTarget: number): number` returning `ageTarget * 2`.

**Why this is first:** without it, ten fallback versions hold three distinct texts, and the slider still lies whenever the LLM is off — which is the whole failure this feature exists to fix.

- [ ] **Step 1: Replace the existing band test**

In `server/tests/pipeline.test.ts`, replace the `it.each` at lines 81-84:

```ts
  it.each([[5, 10], [6, 12], [7, 14], [8, 16], [9, 18], [10, 20], [11, 22], [12, 24], [13, 26], [14, 28]])(
    'age %i allows %i words per sentence',
    (age, limit) => expect(maxWordsForAge(age)).toBe(limit),
  );

  it('keeps §9.2’s three stated anchors exactly', () => {
    // The PRD gives "<=7 -> 14; <=10 -> 20; else 28". age * 2 reproduces all
    // three at the boundary ages, which is why it is a safe generalisation.
    expect(maxWordsForAge(7)).toBe(14);
    expect(maxWordsForAge(10)).toBe(20);
    expect(maxWordsForAge(14)).toBe(28);
  });

  it('gives every age its own limit, so ten versions really differ', () => {
    const limits = Array.from({ length: 10 }, (_, i) => maxWordsForAge(5 + i));
    expect(new Set(limits).size).toBe(10);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/pipeline.test.ts`
Expected: FAIL — `age 5 allows 10 words` gets 14, `age 8` gets 20, `age 11` gets 28.

- [ ] **Step 3: Replace the band function**

In `server/src/pipeline/simplify.ts`:

```ts
/**
 * Words per sentence for one reading age.
 *
 * §9.2 states three bands: "<=7 -> max 14 words/sentence; <=10 -> 20; else 28".
 * A story now exists in one version per age (5-14), so three bands would make
 * ages 5, 6 and 7 byte-identical and the reading-age slider would still change
 * nothing across most of its travel.
 *
 * `age * 2` reproduces all three of §9.2's anchors exactly — 7 -> 14, 10 -> 20,
 * 14 -> 28 — while giving every age its own limit. Ages below an anchor do get
 * shorter sentences than before (age 5 goes from 14 to 10), which is the point.
 */
export function maxWordsForAge(ageTarget: number): number {
  return ageTarget * 2;
}
```

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. Other suites exercise the local pipeline at the default age (6), whose limit changes from 14 to 12 — if a test asserts on exact fallback text it will fail, and that is a real behaviour change to look at, not to paper over.

- [ ] **Step 5: Commit**

```bash
git add server/src/pipeline/simplify.ts server/tests/pipeline.test.ts
git commit -m "feat: give every reading age its own sentence length"
```

---

## Task 2: Hoist the prompt guard so it costs one call per story

**Files:**
- Modify: `server/src/pipeline/simplifyArticle.ts`
- Test: `server/tests/llm.test.ts`

**Interfaces:**
- Consumes: `PromptGuardOutcome` from `server/src/pipeline/promptGuard.js`.
- Produces: `SimplifyOptions.promptGuard?: PromptGuardOutcome` — when supplied, `simplifyArticle` uses it instead of calling `runPromptGuard` itself.

**Why:** `runPromptGuard` is currently called inside `simplifyArticle`. Ten calls per story would mean ten guard calls, doubling the cost of the whole feature for a verdict on source text that does not vary by age.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/llm.test.ts`:

```ts
describe('sharing one prompt-guard verdict across ages', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => ctx.close());

  const RAW_INPUT = {
    id: 'r1', headline: 'A reef was surveyed', body: 'A rover surveyed the reef today.',
    topic: 'World', sourceName: 'BBC News', sourceUrl: 'https://example.com/a',
  };

  /** Counts how many completions the client is asked for. */
  function countingClient(reply: string) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: reply } }],
          usage: { total_tokens: 10 },
        }),
      };
    }) as unknown as typeof fetch;

    return {
      client: new OpenRouterClient({ apiKey: 'test-key', fetchImpl, maxRetries: 1 }),
      calls: () => calls,
    };
  }

  const GOOD_REPLY = JSON.stringify({
    kidHeadline: 'A reef was looked at', summary: 'Divers looked at a reef.',
    whatHappened: 'They went down deep.', whyItMatters: 'Reefs matter.',
    thinkAbout: 'What lives on a reef?', safety: 'calm', readingMinutes: 2,
    vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  });

  it('makes its own guard call when none is supplied', async () => {
    ctx.db.prepare(
      `UPDATE guard_config SET promptGuardEnabled = 1, promptGuardText = 'Classify: {{body}}'
       WHERE id = 'default'`,
    ).run();
    const { client, calls } = countingClient(GOOD_REPLY);

    await simplifyArticle(ctx.db, RAW_INPUT, { ageTarget: 8, client });

    // One guard call plus one simplification call.
    expect(calls()).toBe(2);
  });

  it('uses a supplied verdict instead of calling the guard again', async () => {
    ctx.db.prepare(
      `UPDATE guard_config SET promptGuardEnabled = 1, promptGuardText = 'Classify: {{body}}'
       WHERE id = 'default'`,
    ).run();
    const { client, calls } = countingClient(GOOD_REPLY);

    const outcome = await simplifyArticle(ctx.db, RAW_INPUT, {
      ageTarget: 8,
      client,
      promptGuard: {
        ok: true, raw: 'skip', result: { guard: 'prompt-guard', safety: 'skip-young', matches: [] },
      },
    });

    // Only the simplification call. Ten ages sharing one verdict is the point.
    expect(calls()).toBe(1);
    // And the supplied verdict still counts as a guard: strictest wins (§6).
    expect(outcome.article.safety).toBe('skip-young');
  });
});
```

Add to `server/tests/llm.test.ts`'s imports:

```ts
import { afterEach, beforeEach } from 'vitest';
import { simplifyArticle } from '../src/pipeline/simplifyArticle.js';
import { createTestContext, type TestContext } from './helpers.js';
```

Reuse whichever of `afterEach`/`beforeEach` the file already imports rather than importing twice.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/llm.test.ts`
Expected: FAIL — `promptGuard` is not a valid option (typecheck error), and the second test counts 2 calls.

- [ ] **Step 3: Add the injection point**

In `server/src/pipeline/simplifyArticle.ts`, extend the options:

```ts
export interface SimplifyOptions extends LocalPipelineOptions {
  ageTarget?: number;
  /** Force the rule-based path — used to produce a comparison. */
  forceLocal?: boolean;
  /** Overrides the stored prompt; the sandbox passes a draft here. */
  promptOverride?: string;
  /** Overrides the configured model. */
  model?: string;
  client?: OpenRouterClient;
  /**
   * A prompt-guard verdict already obtained for this article. §6.2's guard
   * judges the SOURCE text, which does not vary by age, so a caller producing
   * one version per age runs it once and passes the same outcome in for all
   * ten — otherwise the guard costs ten calls per story instead of one.
   */
  promptGuard?: PromptGuardOutcome;
}
```

Add the type import:

```ts
import { runPromptGuard, type PromptGuardOutcome } from './promptGuard.js';
```

Replace the guard call:

```ts
  // §6.2: an optional second opinion on safety. Off unless an editor enables
  // it, because it costs a second call per article — so a caller doing ten
  // ages supplies the verdict rather than paying for it ten times.
  const promptGuard =
    options.promptGuard ??
    (guardConfig.promptGuardEnabled
      ? await runPromptGuard(guardConfig.promptGuardText, promptContext, client)
      : undefined);
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pipeline/simplifyArticle.ts server/tests/llm.test.ts
git commit -m "feat: let one prompt-guard verdict serve every age"
```

---

## Task 3: simplifyArticleForAllAges

**Files:**
- Modify: `server/src/pipeline/simplifyArticle.ts`
- Test: `server/tests/llm.test.ts`

**Interfaces:**
- Consumes: `simplifyArticle`, `SimplifyOptions.promptGuard` (Task 2); `MIN_AGE`, `MAX_AGE` from `server/src/core/article.js`.
- Produces:
  ```ts
  export interface AllAgesOutcome {
    /** One per age, MIN_AGE..MAX_AGE, in ascending age order. */
    versions: SimplifyOutcome[];
    /** The shared §6.2 verdict, present only when the guard ran. */
    promptGuard?: PromptGuardOutcome;
    /** Summed across every version plus the one guard call. */
    costUsd: number;
    /** One entry per age that fell back, already prefixed with its age. */
    fallbacks: string[];
  }
  export async function simplifyArticleForAllAges(
    db: Database, raw: RawArticleInput, options?: Omit<SimplifyOptions, 'ageTarget' | 'promptGuard'>,
  ): Promise<AllAgesOutcome>
  ```

- [ ] **Step 1: Write the failing test**

Append to `server/tests/llm.test.ts`:

```ts
describe('simplifyArticleForAllAges', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => ctx.close());

  const RAW_INPUT = {
    id: 'r1', headline: 'A reef was surveyed', body: 'A rover surveyed the reef today.',
    topic: 'World', sourceName: 'BBC News', sourceUrl: 'https://example.com/a',
  };

  const reply = (headline: string) => JSON.stringify({
    kidHeadline: headline, summary: 'Divers looked at a reef.',
    whatHappened: 'They went down deep.', whyItMatters: 'Reefs matter.',
    thinkAbout: 'What lives on a reef?', safety: 'calm', readingMinutes: 2,
    vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  });

  /** A client whose nth completion is decided by the caller. */
  function scriptedClient(replyFor: (call: number) => { ok: boolean; body: string }) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const { ok, body } = replyFor(calls);
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () =>
          ok
            ? { choices: [{ message: { content: body } }], usage: { total_tokens: 10 } }
            : { error: { message: body } },
      };
    }) as unknown as typeof fetch;

    return {
      client: new OpenRouterClient({ apiKey: 'test-key', fetchImpl, maxRetries: 1 }),
      calls: () => calls,
    };
  }

  it('returns one version per age, in ascending age order', async () => {
    const { client } = scriptedClient(() => ({ ok: true, body: reply('A kid headline') }));

    const outcome = await simplifyArticleForAllAges(ctx.db, RAW_INPUT, { client });

    expect(outcome.versions).toHaveLength(10);
    expect(outcome.versions.map((v) => v.article.ageTarget)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(outcome.versions.every((v) => v.article.status === 'pending_review')).toBe(true);
    expect(outcome.versions.every((v) => v.article.publishedAt === null)).toBe(true);
  });

  it('gives every version its own id but the same originalId source', async () => {
    const { client } = scriptedClient(() => ({ ok: true, body: reply('A kid headline') }));

    const outcome = await simplifyArticleForAllAges(ctx.db, RAW_INPUT, { client });

    const ids = outcome.versions.map((v) => v.article.id);
    expect(new Set(ids).size).toBe(10);
    expect(outcome.versions.every((v) => v.article.originalId === 'r1')).toBe(true);
  });

  it('runs the prompt guard once, not once per age', async () => {
    ctx.db.prepare(
      `UPDATE guard_config SET promptGuardEnabled = 1, promptGuardText = 'Classify: {{body}}'
       WHERE id = 'default'`,
    ).run();
    const { client, calls } = scriptedClient(() => ({ ok: true, body: reply('A kid headline') }));

    await simplifyArticleForAllAges(ctx.db, RAW_INPUT, { client });

    // One guard call + ten simplification calls. Eleven, not twenty.
    expect(calls()).toBe(11);
  });

  it('falls back only for the age whose call failed', async () => {
    // The third call (age 7) fails; the other nine succeed.
    const { client } = scriptedClient((n) =>
      n === 3 ? { ok: false, body: 'upstream exploded' } : { ok: true, body: reply('A kid headline') },
    );

    const outcome = await simplifyArticleForAllAges(ctx.db, RAW_INPUT, { client });

    const engines = new Map(outcome.versions.map((v) => [v.article.ageTarget, v.engine]));
    expect(engines.get(7)).toBe('local-fallback');
    expect(engines.get(6)).toBe('llm');
    expect(engines.get(8)).toBe('llm');
    // The reason names the age, so a reviewer knows which version is weaker.
    expect(outcome.fallbacks.some((reason) => reason.includes('age 7'))).toBe(true);
    expect(outcome.fallbacks).toHaveLength(1);
  });

  it('sums the cost across every version', async () => {
    const { client } = scriptedClient(() => ({ ok: true, body: reply('A kid headline') }));

    const outcome = await simplifyArticleForAllAges(ctx.db, RAW_INPUT, { client });

    expect(outcome.costUsd).toBeGreaterThan(0);
  });

  it('uses each age’s own prompt when one is configured', async () => {
    // Only age 9 has an override, so exactly one call should carry its text.
    ctx.db.prepare(
      `UPDATE translation_prompt_config
         SET genericPrompt = 'GENERIC for {{age}}: {{body}}',
             ageOverrides = '{"9":"AGE NINE ONLY: {{body}}"}'
       WHERE id = 'default'`,
    ).run();

    const prompts: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      prompts.push(JSON.parse(String(init.body)).messages[0].content);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: reply('A kid headline') } }],
          usage: { total_tokens: 10 },
        }),
      };
    }) as unknown as typeof fetch;

    await simplifyArticleForAllAges(ctx.db, RAW_INPUT, {
      client: new OpenRouterClient({ apiKey: 'test-key', fetchImpl, maxRetries: 1 }),
    });

    expect(prompts.filter((p) => p.includes('AGE NINE ONLY'))).toHaveLength(1);
    expect(prompts.filter((p) => p.includes('GENERIC for'))).toHaveLength(9);
    // The generic prompt is rendered with each age, not a single default.
    expect(prompts.some((p) => p.includes('GENERIC for 5'))).toBe(true);
    expect(prompts.some((p) => p.includes('GENERIC for 14'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/llm.test.ts`
Expected: FAIL — `simplifyArticleForAllAges` is not exported.

- [ ] **Step 3: Implement it**

Append to `server/src/pipeline/simplifyArticle.ts`, and add `MIN_AGE, MAX_AGE` to the existing `../core/article.js` import:

```ts
/** Every reading age the slider offers (§3.6), ascending. */
const ALL_AGES = Array.from({ length: MAX_AGE - MIN_AGE + 1 }, (_, i) => MIN_AGE + i);

export interface AllAgesOutcome {
  /** One per age, MIN_AGE..MAX_AGE, in ascending age order. */
  versions: SimplifyOutcome[];
  /** The shared §6.2 verdict, present only when the guard ran. */
  promptGuard?: PromptGuardOutcome;
  /** Summed across every version plus the one guard call. */
  costUsd: number;
  /** One entry per age that fell back, already prefixed with its age. */
  fallbacks: string[];
}

/**
 * One version of a story per reading age (§3.6), so the public slider selects
 * real content rather than relabelling one version.
 *
 * Ten calls, not one combined call: every stored prompt template embeds the
 * article and its own JSON envelope, so combining them would either send the
 * article ten times or mangle the templates — and the saving was 40 cents a
 * month against losing per-age prompt control and the sandbox's fidelity to
 * production (§7.4).
 *
 * The §6.2 prompt guard runs ONCE and is shared, because it judges the source
 * article and that does not vary by age.
 *
 * Sequential on purpose. A run is already a background job that warns it takes
 * minutes, and limited concurrency is a later change that has to consider the
 * provider's rate limits.
 */
export async function simplifyArticleForAllAges(
  db: Database,
  raw: RawArticleInput,
  options: Omit<SimplifyOptions, 'ageTarget' | 'promptGuard'> = {},
): Promise<AllAgesOutcome> {
  const settings = createSettingsRepository(db);
  const guardConfig = settings.getGuardConfig();

  // Shared across all ten ages. Uses the youngest age purely to render the
  // guard prompt's {{age}} variable; the verdict is about the source text.
  let promptGuard: PromptGuardOutcome | undefined;
  if (guardConfig.promptGuardEnabled && !options.forceLocal) {
    const client = options.client ?? new OpenRouterClient({ model: options.model });
    promptGuard = await runPromptGuard(
      guardConfig.promptGuardText,
      {
        headline: raw.headline,
        body: raw.body,
        category: raw.topic,
        sourceName: raw.sourceName,
        age: MIN_AGE,
      },
      client,
    );
  }

  const versions: SimplifyOutcome[] = [];
  const fallbacks: string[] = [];
  let costUsd = promptGuard?.costUsd ?? 0;

  for (const ageTarget of ALL_AGES) {
    const outcome = await simplifyArticle(db, raw, { ...options, ageTarget, promptGuard });

    versions.push(outcome);
    costUsd += outcome.costUsd ?? 0;
    // Prefixed with the age: a reviewer needs to know WHICH version is weaker,
    // and with per-age calls a story can be nine parts LLM and one part local.
    if (outcome.fallbackReason) fallbacks.push(`age ${ageTarget}: ${outcome.fallbackReason}`);
  }

  return { versions, promptGuard, costUsd, fallbacks };
}
```

Note: `simplifyArticle` already adds `promptGuard?.costUsd` to its own `costUsd`, so passing a shared verdict in would double-count it. Change that line in `simplifyArticle`'s success return to count the guard only when it made the call itself:

```ts
      // Both calls are billed, so both are reported — but a guard verdict
      // supplied by the caller was billed to the caller, not to this version.
      costUsd: (result.costUsd ?? 0) + (options.promptGuard ? 0 : (promptGuard?.costUsd ?? 0)),
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pipeline/simplifyArticle.ts server/tests/llm.test.ts
git commit -m "feat: simplify one story into a version for every reading age"
```

---

## Task 4: Store ten versions per story, atomically

**Files:**
- Modify: `server/src/services/simplifyService.ts`
- Test: `server/tests/simplify-service.test.ts`

**Interfaces:**
- Consumes: `simplifyArticleForAllAges` and `AllAgesOutcome` (Task 3).
- Produces: `SimplifiedRow` gains `versions: number`; `SimplifyReport` unchanged in shape, still one `SimplifiedRow` per story.

**The atomicity rule:** all ten versions and the `simplifiedAt` claim commit together. This differs deliberately from the budget feature's per-article commits — a story holding four of ten versions cannot be reviewed or published coherently, so there is no partial state worth keeping.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/simplify-service.test.ts`, inside the `describe('simplifyRawArticles')` block:

```ts
  it('creates one version per reading age', async () => {
    seedWaiting('r1');

    await simplifyRawArticles(ctx.db, ['r1']);

    const ages = ctx.db
      .prepare(`SELECT ageTarget FROM kid_articles WHERE originalId = 'r1' ORDER BY ageTarget`)
      .pluck().all();
    expect(ages).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('reports how many versions a story produced', async () => {
    seedWaiting('r1');

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    // One row per STORY, carrying the version count — not ten rows.
    expect(report.simplified).toHaveLength(1);
    expect(report.simplified[0].versions).toBe(10);
  });

  it('never auto-publishes any version', async () => {
    seedWaiting('r1');

    await simplifyRawArticles(ctx.db, ['r1']);

    const statuses = ctx.db.prepare(`SELECT DISTINCT status FROM kid_articles`).pluck().all();
    expect(statuses).toEqual(['pending_review']);
    expect(
      ctx.db.prepare(`SELECT COUNT(*) c FROM kid_articles WHERE publishedAt IS NOT NULL`).get(),
    ).toEqual({ c: 0 });
  });

  it('raises every version when the deny-list fires', async () => {
    // §6: the deny-list judges the source article, so a hit must apply to all
    // ten ages. A story that is skip-young at 5 cannot be calm at 14.
    seedWaiting('r1', {
      headline: 'A disaster and an earthquake struck',
      body: 'A disaster struck. An earthquake killed people. There was violence.',
    });

    await simplifyRawArticles(ctx.db, ['r1']);

    const safeties = ctx.db.prepare(`SELECT DISTINCT safety FROM kid_articles`).pluck().all();
    expect(safeties).toEqual(['skip-young']);
  });

  it('gives every version the same original article link', async () => {
    seedWaiting('r1', { url: 'https://www.bbc.co.uk/news/articles/the-story' });

    await simplifyRawArticles(ctx.db, ['r1']);

    const links = ctx.db.prepare(`SELECT DISTINCT sourceUrl FROM kid_articles`).pluck().all();
    expect(links).toEqual(['https://www.bbc.co.uk/news/articles/the-story']);
  });

  it('writes all ten versions or none', async () => {
    seedWaiting('r1');
    // A trigger that aborts the age-14 insert. The versions are written in
    // ascending age order, so this fails on the LAST one — the case that proves
    // the earlier nine are rolled back rather than left behind.
    ctx.db.exec(`
      CREATE TRIGGER fail_on_age_14 BEFORE INSERT ON kid_articles
      WHEN NEW.ageTarget = 14
      BEGIN SELECT RAISE(ABORT, 'simulated failure on the last version'); END;
    `);

    const report = await simplifyRawArticles(ctx.db, ['r1']);

    expect(report.failures).toHaveLength(1);
    expect(report.simplified).toEqual([]);
    // Nothing partial survived, and the story is still waiting to be retried.
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    expect(createRawArticleRepository(ctx.db).findById('r1')?.simplifiedAt).toBeNull();
    expect(createRawArticleRepository(ctx.db).countWaiting()).toBe(1);

    ctx.db.exec('DROP TRIGGER fail_on_age_14');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/simplify-service.test.ts`
Expected: FAIL — only one row is created, so `ages` is `[6]` (the default age) and `versions` is undefined.

- [ ] **Step 3: Switch the service to all ages**

In `server/src/services/simplifyService.ts`, change the import:

```ts
import { simplifyArticleForAllAges } from '../pipeline/simplifyArticle.js';
```

Extend the reported row:

```ts
export interface SimplifiedRow {
  rawId: string;
  /** Carried so a scrape run can attribute the cost back to the right source. */
  sourceId: string;
  /** The youngest version's headline, as a label for the story. */
  kidHeadline: string;
  /** The strictest safety across every version — what an editor must see first. */
  safety: string;
  /** 'llm', 'local-fallback', or 'mixed' when the ages disagree. */
  engine: string;
  /** How many versions were written. Ten unless something failed. */
  versions: number;
  costUsd: number;
  fallbackReason?: string;
}
```

Replace the body of the per-article `try` block, from the `const now = clock();` line through the `report.simplified.push({...})` call:

```ts
      const now = clock();
      // One version per reading age (§3.6). simplifyArticle never throws: it
      // falls back to the rule-based pipeline (§9.2) per age and flags why.
      const outcome = await simplifyArticleForAllAges(db, {
        id: raw.id,
        headline: raw.headline,
        body: raw.body,
        topic: raw.topic,
        sourceName: raw.sourceName,
        // raw.url is the story; raw.sourceUrl is the rss.xml it came from.
        sourceUrl: raw.url,
      }, { now, client: options.client });

      const claimed = db.transaction(() => {
        // The claim and every version commit together: a story holding four of
        // ten versions cannot be reviewed or published coherently.
        if (!raws.markSimplified(raw.id, now)) return false;
        for (const version of outcome.versions) {
          articles.insert({
            ...version.article,
            originalId: raw.id,
            // §5.2 step 7: never auto-publish, whatever the guard decided.
            status: 'pending_review',
            publishedAt: null,
          });
        }
        return true;
      })();

      if (!claimed) {
        report.skipped.push(rawId);
        continue;
      }

      const engines = new Set(outcome.versions.map((version) => version.engine));
      const youngest = outcome.versions[0];

      report.simplified.push({
        rawId: raw.id,
        sourceId: raw.sourceId,
        kidHeadline: youngest.article.kidHeadline,
        // The strictest across ages, so the queue cannot show 'calm' for a
        // story that is 'skip-young' at age 5.
        safety: outcome.versions.reduce(
          (worst, version) => (SAFETY_RANK[version.article.safety] > SAFETY_RANK[worst] ? version.article.safety : worst),
          'calm' as string,
        ),
        engine: engines.size === 1 ? [...engines][0] : 'mixed',
        versions: outcome.versions.length,
        costUsd: outcome.costUsd,
        fallbackReason: outcome.fallbacks.length > 0 ? outcome.fallbacks.join('; ') : undefined,
      });
```

Add the ranking constant near the top of the file, below the imports:

```ts
/** §6's severity order, for reporting the strictest verdict across ages. */
const SAFETY_RANK: Record<string, number> = { calm: 0, 'adult-nearby': 1, 'skip-young': 2 };
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS. `ingestion.test.ts`'s budget tests assert `countRows(ctx.db, 'kid_articles')` — with ten versions each, a budget of 10 now creates 100 rows, so those assertions change in Task 5. Expect them to fail here and fix them there rather than loosening them now.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/simplifyService.ts server/tests/simplify-service.test.ts
git commit -m "feat: store one version per reading age for each story"
```

---

## Task 5: Count versions in run reporting

**Files:**
- Modify: `server/src/ingestion/rssScraper.ts` (`ScrapeResult`)
- Modify: `server/src/services/scrapeService.ts` (`summarise`, attribution)
- Modify: `server/src/db/schema.sql`, `server/src/db/init.ts`
- Modify: `server/src/db/repositories/scrapeRunRepository.ts`
- Modify: `server/src/ingestion/scheduler.ts`, `server/scripts/scrape.ts`
- Test: `server/tests/ingestion.test.ts`, `server/tests/scrape-run.test.ts`, `server/tests/db.test.ts`

**Interfaces:**
- Consumes: `SimplifiedRow.versions` (Task 4).
- Produces: `ScrapeResult.versionsCreated: number`; `ScrapeRun.versions: number`; `summarise()` gains `versions`; `scrape_runs.versions` column; `SCHEMA_VERSION = 4`.

The name differs on purpose in one place: `ScrapeResult` already has a
`simplified` **array**, so a bare `versions` there would read as another array.
It is `versionsCreated` on `ScrapeResult` and plain `versions` everywhere the
surrounding fields are all counts.

**Why it matters:** the settings page reads the *persisted* run, and an editor who sets a budget of 10 needs to see "10 stories, 100 versions" or the budget's meaning is invisible.

- [ ] **Step 1: Write the failing tests**

In `server/tests/ingestion.test.ts`, update the budget assertions and add one:

```ts
  it('stores everything but simplifies only the budget', async () => {
    const state = await runToCompletion(10);

    expect(countRows(ctx.db, 'raw_articles')).toBe(25);
    // Ten stories, ten reading ages each.
    expect(countRows(ctx.db, 'kid_articles')).toBe(100);
    expect(waitingCount()).toBe(15);
    expect(summarise(state).simplified).toBe(10);
    expect(summarise(state).versions).toBe(100);
  });
```

and in the same describe, replace the two other kid-article counts:

```ts
  it('a second run works through the backlog rather than re-fetching', async () => {
    await runToCompletion(10);
    const state = await runToCompletion(10);

    expect(summarise(state).inserted).toBe(0);
    expect(countRows(ctx.db, 'kid_articles')).toBe(200);
    expect(waitingCount()).toBe(5);
  });

  it('reads the budget from app_settings when none is passed', async () => {
    ctx.db.prepare(`UPDATE app_settings SET simplifyBudget = 2 WHERE id = 'default'`).run();

    await runToCompletion();

    expect(countRows(ctx.db, 'kid_articles')).toBe(20);
  });
```

Add to `server/tests/scrape-run.test.ts`:

```ts
  it('records the version count, so a budget of 10 does not look like 10 articles', () => {
    itemCount = 3;

    startScrapeRun(ctx.db, { budget: 2 });
    return waitForRun().then(() => {
      const run = createScrapeRunRepository(ctx.db).latestPerSource().bbc;
      expect(run.simplified).toBe(2);
      expect(run.versions).toBe(20);
    });
  });
```

Add to `server/tests/db.test.ts`, in the `describe('schema (§8)')` block:

```ts
  it('adds the run version count when migrating from v3', () => {
    initialiseSchema(path);
    seed(path);

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect((db.pragma('table_info(scrape_runs)') as { name: string }[]).map((c) => c.name))
      .toContain('versions');
    db.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/ingestion.test.ts tests/scrape-run.test.ts tests/db.test.ts`
Expected: FAIL — `summarise(...).versions` and `run.versions` are undefined, `user_version` is 3.

- [ ] **Step 3: Add the column and bump the schema**

In `server/src/db/schema.sql`, in the `scrape_runs` block after `simplified`:

```sql
  versions             INTEGER NOT NULL DEFAULT 0,             -- age versions written across those stories
```

In `server/src/db/init.ts`, bump the version and register the column:

```ts
 * 4 — added scrape_runs.versions (one story now yields one version per age).
 */
export const SCHEMA_VERSION = 4;
```

and add to `ADDED_COLUMNS`:

```ts
  { table: 'scrape_runs', column: 'versions', definition: 'INTEGER NOT NULL DEFAULT 0' },
```

The existing `addMissingColumns` pass handles it; no backfill is needed, because a run recorded before this change genuinely had one version per story and 0 is a truthful "not measured".

- [ ] **Step 4: Thread the count through**

`server/src/ingestion/rssScraper.ts` — add to `ScrapeResult` after `simplified`:

```ts
  /** Age versions written for this source's stories, filled by phase 2. */
  versionsCreated: number;
```

and to `emptyResult`:

```ts
    versionsCreated: 0,
```

`server/src/services/scrapeService.ts` — add to `failedResult`:

```ts
    versionsCreated: 0,
```

in the attribution loop, after `result.costUsd += row.costUsd;`:

```ts
        result.versionsCreated += row.versions;
```

and in `summarise`:

```ts
    versions: state.results.reduce((total, r) => total + r.versionsCreated, 0),
```

`server/src/db/repositories/scrapeRunRepository.ts` — add `versions: number` to `ScrapeRun` beneath `simplified`, add `versions` to the INSERT's column and `VALUES` lists, and to the recorded row:

```ts
        versions: result.versionsCreated,
```

`server/src/ingestion/scheduler.ts` — extend the success log:

```ts
          `[scrape] ${result.sourceId}: ${result.inserted} stored, ` +
            `${result.simplified.length} simplified into ${result.versionsCreated} versions, ` +
            `${result.leftWaiting} waiting, ` +
```

`server/scripts/scrape.ts` — in `report`, after the SIMPLIFIED line:

```ts
  console.log(`  VERSIONS             ${result.versionsCreated}`);
```

and in the totals footer:

```ts
    const versions = results.reduce((total, r) => total + r.versionsCreated, 0);
    console.log(
      `Total stored: ${inserted}   Simplified: ${simplified} stories / ${versions} versions   ` +
        `Sources failed: ${failed.length}`,
    );
```

- [ ] **Step 5: Run the whole suite**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.sql server/src/db/init.ts \
        server/src/db/repositories/scrapeRunRepository.ts server/src/ingestion/rssScraper.ts \
        server/src/services/scrapeService.ts server/src/ingestion/scheduler.ts \
        server/scripts/scrape.ts server/tests/ingestion.test.ts \
        server/tests/scrape-run.test.ts server/tests/db.test.ts
git commit -m "feat: report how many age versions a run created"
```

---

## Task 6: Say what the budget now costs

**Files:**
- Modify: `web/src/pages/admin/settings/types.ts`
- Modify: `web/src/pages/admin/settings/AppSettingsSection.tsx`
- Modify: `web/src/pages/admin/settings/ScrapeControls.tsx`
- Test: `web/src/__tests__/admin-step7.test.tsx`

**Interfaces:**
- Consumes: `ScrapeRun.versions` (Task 5).
- Produces: no new exports.

**Why:** a budget of 10 is now 100 model calls. An editor reading "Simplifications per scrape run: 10" will assume ten calls, and the number they are tuning is ten times bigger than it looks.

- [ ] **Step 1: Write the failing test**

First extend this file's `/scrape/status` mock so `lastRuns.bbc` carries the new field, beside `simplified: 10`:

```tsx
          itemsInFeed: 45, inserted: 41, simplified: 10, versions: 100, leftWaiting: 31,
```

Then add to the `describe('settings — §8.7 app settings')` block:

```tsx
  it('warns that the budget counts stories, not model calls', async () => {
    renderIn(<AdminSettings />);
    const help = await screen.findByText(/each story is rewritten once for every reading age/i);
    expect(help).toHaveTextContent(/10 stories/);
    expect(help).toHaveTextContent(/100 model calls/);
  });

  it('shows the version count for the last run', async () => {
    renderIn(<AdminSettings />);
    const lastRun = await screen.findByText(/already seen/);
    expect(lastRun).toHaveTextContent(/100 versions/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/admin-step7.test.tsx`
Expected: FAIL — no element matching `/each story is rewritten once for every reading age/i`.

- [ ] **Step 3: Add the field to the type**

In `web/src/pages/admin/settings/types.ts`, in `ScrapeRun` below `simplified`:

```ts
  /** Age versions written across those stories. */
  versions: number;
```

- [ ] **Step 4: Rewrite the budget help text**

In `web/src/pages/admin/settings/AppSettingsSection.tsx`, add the import and a derived
count — the Global Constraints forbid hardcoding the age range, and 10 is derived from it:

```tsx
import { MAX_AGE, MIN_AGE } from '../../../settings/SettingsContext';

/** One model call per reading age, so this is the multiplier on the budget. */
const AGE_COUNT = MAX_AGE - MIN_AGE + 1;
```

then replace the paragraph under the budget input:

```tsx
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
        How many stored stories a run may send to the model. Each story is rewritten once for
        every reading age from {MIN_AGE} to {MAX_AGE}, so{' '}
        <strong>{draft.simplifyBudget} stories is {draft.simplifyBudget * AGE_COUNT} model
        calls</strong>. The rest are kept as they came in, costing nothing, and wait in the
        review queue’s “Not yet simplified” tab until you ask for them. 0 means simplify
        nothing automatically.
      </p>
```

`MIN_AGE` and `MAX_AGE` are already exported from `web/src/settings/SettingsContext.tsx`
as 5 and 14.

- [ ] **Step 5: Show versions in the last-run line**

In `web/src/pages/admin/settings/ScrapeControls.tsx`, in `LastRunSummary`, replace the `simplified` fragment:

```tsx
      {run.simplified > 0 && (
        <>, <strong>{run.simplified}</strong> simplified into <strong>{run.versions}</strong> versions</>
      )}
```

- [ ] **Step 6: Run the web suite**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS. Other settings tests share the `/scrape/status` mock updated in Step 1; if one asserts on the old wording, update the assertion — the wording change is deliberate.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/admin/settings/ web/src/__tests__/admin-step7.test.tsx
git commit -m "feat: say that the budget counts stories, not model calls"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the pipeline diagram**

The diagram under `## How a story reaches a reader` currently ends its simplify branch at `kid_articles`. Replace that branch line so the ten versions are visible:

```
BBC RSS feed ─┐                  first 10 per run
              ├─→ raw_articles ─┬─→ guard + simplify ─→ kid_articles
paste by hand ┘                 │   (once per age, 5-14)  (10 versions,
                                │                          pending_review)
                                │                             │
                                │                 an editor approves it
                                │                             ↓
                                │                        published → the site
                                └─→ the rest wait, unsimplified and free,
                                    under "Not yet simplified" in /admin/review
```

- [ ] **Step 2: Add a section after "The simplification budget"**

```markdown
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
to production.

Failures are per age: if the age-7 call fails, age 7 falls back to the
rule-based pipeline (§9.2) and the other nine keep their model versions. The
review queue therefore shows the engine per version.

The §6 guards run **once per story** — they judge the source article, which does
not vary by age — so the prompt guard costs one call, not ten.

Without an API key the rule-based pipeline handles every age, using
`age * 2` words per sentence. That reproduces §9.2's three stated anchors
exactly (7 → 14, 10 → 20, 14 → 28) while giving every age its own limit, so the
slider still changes the text offline.
```

- [ ] **Step 3: Fix the cost and table sections**

In the cost paragraph, the sentence now reading "A run costs the simplification budget, not the size of the feed, so the default of 10 is about $0.002 a day" understates it tenfold. Replace with:

```markdown
Roughly **$0.0002 per article version** on the default model. A run costs the
budget times ten, because each story is rewritten for every reading age — so
the default of 10 stories is 100 calls, about $0.03 a day. Several guards keep
it that way — the budget in `/admin/settings`, and these in `.env`:
```

In the tables list, replace the `kid_articles` and `scrape_runs` rows:

```markdown
| `kid_articles`                      | Rewritten stories, one row per reading age, and their review status |
| `scrape_runs`                       | What each scrape stored, simplified, versioned and left raw          |
```

- [ ] **Step 4: Verify every claim**

Run: `cd server && npm test && npm run typecheck && cd ../web && npm test && npm run typecheck`
Expected: PASS everywhere. Then re-read the new README section against `simplifyArticle.ts` and `simplify.ts` and confirm the numbers, the anchor values and the file names are real.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: explain one story version per reading age"
```

---

## Done-when

- Simplifying one story creates ten `kid_articles` rows, `ageTarget` 5 to 14, all `pending_review` with `publishedAt` NULL.
- A story's ten versions all carry the same `originalId` and the same `sourceUrl` (the article, not the feed).
- Ten simplification calls per story but only **one** prompt-guard call.
- One age's call failing leaves that age on `local-fallback` and the other nine on `llm`, with the reason naming the age.
- A write failure on any version rolls back all ten and leaves the story waiting.
- `maxWordsForAge` returns `age * 2`, ten distinct values, matching §9.2 at ages 7, 10 and 14.
- A budget of 10 produces 100 versions, and the run row records both numbers.
- The settings page says a budget of 10 is 100 model calls.
- `cd server && npm test && npm run typecheck` and `cd web && npm test && npm run typecheck` all pass.

## Not in this phase

- The review queue still shows ten rows per story. That is worse for an editor
  than today and is exactly what Phase 2 fixes, so these should not sit far
  apart.
- The public slider still does nothing. Phase 3.
- Re-simplifying the existing articles into ten versions each.
