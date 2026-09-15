# Audio Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every story version a short broadcast script, written by the model in the call that already writes the story, and let a child play it in the browser.

**Architecture:** One new nullable column on `kid_articles`. The existing simplification prompt gains an `audioScript` key in the JSON envelope it already returns, so there is no second model call. The field then rides every path a story field already rides — regenerate diff, edit dialog, sandbox output, publish. The browser speaks it with `SpeechSynthesis`, one utterance per sentence.

**Tech Stack:** Node 20 + Express + better-sqlite3 (raw SQL, no ORM), React 18 + Vite + TypeScript + Tailwind, Vitest both sides.

**Spec:** `docs/superpowers/specs/2026-09-15-audio-script-design.md`

## Global Constraints

- **`audioScript` is never a required field of the LLM response.** It must not join `REQUIRED_TEXT` in `server/src/llm/llmSimplifier.ts`. A malformed script must cost the script only, never the story.
- **No new model calls.** Call count stays at three per story plus the shared §6.2 guard.
- **Both seeded prompts gain the field.** An override replaces the generic prompt outright (§9.1), so teaching only the generic one leaves ages 5–7 with no audio.
- **The placeholder player stays.** Do not touch the big play button, its progress bar, or its "connect text-to-speech" note on `/podcast`.
- **Nothing a child hears is unreviewed.** The script is stored and published with the story. Never generate or rewrite script prose in the browser.
- Commit messages: one line, no body, no `Co-Authored-By` trailer.
- Run `cd server && npm test` and `cd web && npm test && npx tsc --noEmit` before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/db/schema.sql` | `kid_articles.audioScript` on a fresh database |
| `server/src/db/init.ts` | the same column on an existing one; `SCHEMA_VERSION` 5 → 6 |
| `server/src/core/article.ts` | `audioScript` on `KidArticleRow` and `KidArticle` |
| `server/src/db/repositories/articleRepository.ts` | `COLUMNS` (drives INSERT) and `ArticleContent` (drives edit/regenerate UPDATE) |
| `server/src/llm/llmSimplifier.ts` | `LlmContent.audioScript`, parsed leniently |
| `server/src/pipeline/simplifyArticle.ts` | copy the parsed script onto the article |
| `server/src/pipeline/localPipeline.ts` | rule-based path yields `audioScript: null` |
| `server/src/db/seed-prompts.ts` | both prompts ask for the script |
| `server/src/routes/admin/articleActions.ts` | `PATCH` accepts an edited script |
| `web/src/lib/types.ts` | `audioScript` on the web `KidArticle` |
| `web/src/lib/useSpeech.ts` | **new** — sentence chunking, playback, highlight index |
| `web/src/pages/admin/dialogs/EditDialog.tsx` | a textarea for the script |
| `web/src/pages/admin/dialogs/VersionDiff.tsx` | script appears in the regenerate diff |
| `web/src/pages/admin/sandbox/ResultsPanel.tsx` | script appears in the sandbox diff |
| `web/src/pages/Podcast.tsx` | render the script, play it, highlight the sentence |

`toKidArticle` and `toKidArticleRow` need **no** change: `audioScript` is a plain
`string | null` with no JSON marshalling, so the existing `...row` / `...article`
spread carries it. `regenerateStory.ts` needs no change either — it spreads
`...version.article`.

---

## Task 1: Store an audio script on every version

**Files:**
- Modify: `server/src/db/schema.sql` (kid_articles block, after `thinkAbout`)
- Modify: `server/src/db/init.ts:25` (`SCHEMA_VERSION`), version log comment, `ADDED_COLUMNS`
- Modify: `server/src/core/article.ts` (`KidArticleRow`, `KidArticle`)
- Modify: `server/src/db/repositories/articleRepository.ts:88-100` (`ArticleContent`, `COLUMNS`)
- Modify: `server/src/llm/llmSimplifier.ts` (`LlmContent`, `parseLlmContent`)
- Modify: `server/src/pipeline/simplifyArticle.ts` (article literal)
- Modify: `server/src/pipeline/localPipeline.ts` (article literal)
- Modify: `web/src/lib/types.ts` (`KidArticle`)
- Test: `server/tests/llm.test.ts`, `server/tests/admin-submit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `KidArticle.audioScript: string | null` (server and web), `LlmContent.audioScript: string | null`, `ArticleContent` gains `'audioScript'`.

- [ ] **Step 1: Write the failing parser tests**

In `server/tests/llm.test.ts`, inside `describe('parseLlmContent…')` (find the
existing block that parses `GOOD`):

```ts
describe('audioScript is optional (§9.1)', () => {
  const withScript = (value: unknown) =>
    JSON.stringify({ ...GOOD, audioScript: value });

  it('keeps a well-formed script', () => {
    expect(parseLlmContent(withScript('  A robot went down to the reef.  ')).audioScript)
      .toBe('A robot went down to the reef.');
  });

  it.each([
    ['absent', undefined],
    ['empty', '   '],
    ['not a string', 42],
    ['null', null],
  ])('nulls a %s script rather than failing', (_label, value) => {
    expect(parseLlmContent(withScript(value)).audioScript).toBeNull();
  });

  // The one that matters: a bad script must not cost the story. parseLlmContent
  // throwing sends the WHOLE version to the rule-based fallback.
  it('still returns the story when the script is unusable', () => {
    const content = parseLlmContent(withScript({ nested: 'object' }));
    expect(content.audioScript).toBeNull();
    expect(content.kidHeadline).toBe(GOOD.kidHeadline);
    expect(content.whatHappened).toBe(GOOD.whatHappened);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run tests/llm.test.ts -t "audioScript is optional"`
Expected: FAIL — `audioScript` is not a property of the parsed object (`undefined`, not `null`).

- [ ] **Step 3: Add the field to the parser**

In `server/src/llm/llmSimplifier.ts`, add to `LlmContent` after `feelingNote`:

```ts
  /**
   * The story as a newsreader would say it. Optional on purpose: it must NOT
   * join REQUIRED_TEXT, because a throw here drops the whole version to the
   * rule-based pipeline, and a missing script is a far smaller loss than a
   * lost story — the same rule vocab already follows.
   */
  audioScript: string | null;
```

In `parseLlmContent`, beside the existing `feelingNote` line (around line 136):

```ts
  const audioScript =
    typeof raw.audioScript === 'string' && raw.audioScript.trim()
      ? raw.audioScript.trim()
      : null;
```

and add `audioScript,` to the returned object.

- [ ] **Step 4: Run the parser tests**

Run: `cd server && npx vitest run tests/llm.test.ts -t "audioScript is optional"`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the column to both schema paths**

In `server/src/db/schema.sql`, in `CREATE TABLE IF NOT EXISTS kid_articles`,
directly after the `thinkAbout` line:

```sql
  audioScript     TEXT,                                                  -- spoken version for /podcast; NULL when none was produced
```

In `server/src/db/init.ts`, bump the version and record it in the log comment:

```ts
 * 5 — added kid_articles.approvedBy (records an auto-approved publish).
 * 6 — added kid_articles.audioScript (the spoken version of a story).
 */
export const SCHEMA_VERSION = 6;
```

and append to `ADDED_COLUMNS`:

```ts
  // Nullable with no default: a row written before this column existed has no
  // spoken version, and NULL says exactly that. It is also what a failed or
  // rule-based generation stores, so the podcast page has one case to handle.
  { table: 'kid_articles', column: 'audioScript', definition: 'TEXT' },
```

- [ ] **Step 6: Add the field to the domain types**

In `server/src/core/article.ts`, add to **both** `KidArticleRow` and
`KidArticle`, after `thinkAbout`:

```ts
  audioScript: string | null;
```

Leave `toKidArticle` and `toKidArticleRow` alone — the spread carries it.

- [ ] **Step 7: Wire it through the repository**

In `server/src/db/repositories/articleRepository.ts`, add `'audioScript'` to
`ArticleContent`'s `Pick` (so an edit and a regeneration can write it):

```ts
export type ArticleContent = Pick<
  KidArticle,
  | 'kidHeadline' | 'summary' | 'whatHappened' | 'whyItMatters' | 'vocab'
  | 'thinkAbout' | 'audioScript' | 'feelingNote' | 'safety' | 'contentWarnings'
  | 'category' | 'readingMinutes' | 'ageTarget'
>;
```

and to `COLUMNS`, matching the schema order (after `thinkAbout`):

```ts
const COLUMNS = [
  'id', 'originalId', 'ageTarget', 'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'vocab', 'thinkAbout', 'audioScript', 'feelingNote', 'safety', 'contentWarnings',
  'category', 'readingMinutes', 'sourceName', 'sourceUrl', 'status', 'rejectReason',
  'editedByHuman', 'createdAt', 'publishedAt',
] as const;
```

- [ ] **Step 8: Populate it on both pipeline paths**

In `server/src/pipeline/simplifyArticle.ts`, in the `const article: KidArticle = {`
literal, after `thinkAbout: content.thinkAbout,`:

```ts
      audioScript: content.audioScript,
```

In `server/src/pipeline/localPipeline.ts`, find the `KidArticle` literal built
by `simplifyLocally` and add, after its `thinkAbout` line:

```ts
    // §9.2 rewrites sentences; it does not write broadcast copy. A story that
    // fell back has no spoken version rather than a mechanical one.
    audioScript: null,
```

- [ ] **Step 9: Add the field to the web type**

In `web/src/lib/types.ts`, in `interface KidArticle`, after `thinkAbout`:

```ts
  audioScript: string | null;
```

`AdminArticle` extends `KidArticle`, so `web/src/admin/types.ts` needs no change.

- [ ] **Step 10: Teach the fixtures the new field**

Making `audioScript` required on `KidArticle` breaks every object literal typed
as `KidArticle` or `AdminArticle`. Add `audioScript: null,` after `thinkAbout`
in each of these `BASE`/`ARTICLE` constants — `tsc --noEmit` fails until all six
are done:

- `web/src/__tests__/public-pages.test.tsx:16`
- `web/src/__tests__/safety.test.tsx:16`
- `web/src/__tests__/prototype-parity.test.tsx:17`
- `web/src/__tests__/admin-dialogs.test.tsx:8`
- `web/src/__tests__/admin-review.test.tsx:16`
- `web/src/__tests__/admin-regenerate.test.tsx:16`

Then let server fixtures set one. In `server/tests/helpers.ts`, in
`insertKidArticle`, add `audioScript: string | null;` to the `overrides` type,
`audioScript: null,` to the `row` defaults (after `thinkAbout`), and
`audioScript` / `@audioScript` to its INSERT column and value lists. That
helper writes its own explicit INSERT rather than going through the repository,
so it does not break on its own — but tests need a way to seed a script.

- [ ] **Step 11: Write the round-trip test**

In `server/tests/admin-submit.test.ts`, inside `describe('POST /articles (§4.3 save)')`:

```ts
  it('stores a null audioScript when the local pipeline wrote the version', async () => {
    await post('/api/admin/articles', { ...SUBMISSION, status: 'pending_review' });

    const rows = ctx.db
      .prepare('SELECT audioScript FROM kid_articles')
      .all() as { audioScript: string | null }[];

    // No LLM in this test, so §9.2 ran: a story, but nothing to speak.
    expect(rows).toHaveLength(AGE_BANDS.length);
    expect(rows.every((r) => r.audioScript === null)).toBe(true);
  });
```

- [ ] **Step 12: Run both suites**

Run: `cd server && npm test`
Expected: PASS, 614 tests (607 + 6 parser + 1 round-trip).

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean typecheck, 267 passing. A typecheck error naming a missing
`audioScript` means a fixture in Step 10 was missed.

- [ ] **Step 13: Commit**

```bash
git add server/src/db/schema.sql server/src/db/init.ts server/src/core/article.ts \
  server/src/db/repositories/articleRepository.ts server/src/llm/llmSimplifier.ts \
  server/src/pipeline/simplifyArticle.ts server/src/pipeline/localPipeline.ts \
  web/src/lib/types.ts server/tests/helpers.ts server/tests/llm.test.ts \
  server/tests/admin-submit.test.ts web/src/__tests__/
git commit -m "feat: store a spoken version of every story"
```

---

## Task 2: Ask the seeded prompts for a spoken version

**Files:**
- Modify: `server/src/db/seed-prompts.ts` (both exported prompts)
- Modify: `web/src/pages/admin/sandbox/ResultsPanel.tsx:5-8` (`DIFF_FIELDS`)
- Test: `server/tests/llm.test.ts`

**Interfaces:**
- Consumes: `LlmContent.audioScript` from Task 1.
- Produces: both seeded prompts emit `audioScript`; the sandbox shows it.

- [ ] **Step 1: Write the failing prompt tests**

In `server/tests/llm.test.ts`, inside
`describe('the seeded prompts must keep their safety criteria')`, add:

```ts
  // An override REPLACES the generic prompt (§9.1), so a field taught only to
  // the generic one leaves ages 5-7 — the youngest readers, who need listening
  // most — as the single band with no spoken version.
  it.each([
    ['generic', GENERIC_SIMPLIFICATION_PROMPT],
    ['ages 5-7', YOUNG_READERS_SIMPLIFICATION_PROMPT],
  ])('%s prompt asks for an audioScript', (_label, prompt) => {
    expect(prompt).toContain('"audioScript"');
  });

  it.each([
    ['generic', GENERIC_SIMPLIFICATION_PROMPT],
    ['ages 5-7', YOUNG_READERS_SIMPLIFICATION_PROMPT],
  ])('%s prompt tells the model to write the script from the article', (_label, prompt) => {
    // Otherwise it summarises its own summary and the spoken version is flat.
    expect(prompt).toContain('from the article');
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd server && npx vitest run tests/llm.test.ts -t "audioScript"`
Expected: FAIL — neither prompt contains `"audioScript"`.

- [ ] **Step 3: Teach the generic prompt**

In `server/src/db/seed-prompts.ts`, in `GENERIC_SIMPLIFICATION_PROMPT`, add to
the JSON shape after the `"thinkAbout"` line:

```
  "audioScript": "The story told out loud for radio, for children aged {{ageRange}}. 60 to 90 words.",
```

and add this field note after the `"vocab"` note:

```
- "audioScript" is the same story as a newsreader would say it out loud to
  children aged {{ageRange}}. Write it from the article, not from the summary
  you just wrote — it is a second telling of the news, not a reading of the
  first. Say what happened first. One idea per sentence. Never a clause a
  listener has to hold in their head while you finish. No headings, no bullet
  points, no stage directions, no "welcome back". 60 to 90 words.
```

- [ ] **Step 4: Teach the 5–7 override**

In the same file, in `YOUNG_READERS_SIMPLIFICATION_PROMPT`, add to its JSON
shape after the `"thinkAbout"` line:

```
  "audioScript": "The story read out loud to a 5-year-old. 40 to 60 words.",
```

and add this field note after its `"vocab"` note:

```
- "audioScript" is the same story as a kind grown-up would read it out loud to
  a 5-year-old. Write it from the article, not from the sentences you just
  wrote. Very short sentences, one idea each. Warm and calm. No headings, no
  bullet points, no stage directions. 40 to 60 words.
```

- [ ] **Step 5: Run the prompt tests**

Run: `cd server && npx vitest run tests/llm.test.ts -t "audioScript"`
Expected: PASS (4 tests).

- [ ] **Step 6: Show the script in the sandbox**

In `web/src/pages/admin/sandbox/ResultsPanel.tsx`, add `'audioScript'` to
`DIFF_FIELDS` so tuning the prompt shows what it did to the spoken version:

```ts
const DIFF_FIELDS = [
  'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'thinkAbout', 'audioScript', 'feelingNote', 'safety', 'readingMinutes',
] as const;
```

- [ ] **Step 7: Run both suites**

Run: `cd server && npm test` — expected PASS, 617 tests.
Run: `cd web && npx tsc --noEmit && npm test` — expected clean, 267 passing.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/seed-prompts.ts server/tests/llm.test.ts \
  web/src/pages/admin/sandbox/ResultsPanel.tsx
git commit -m "feat: ask the seeded prompts for a spoken version of the story"
```

---

## Task 3: Carry the audio script through regenerate and edit

**Files:**
- Modify: `server/src/routes/admin/articleActions.ts:36-50` (`readEdit`)
- Modify: `web/src/pages/admin/dialogs/VersionDiff.tsx:4-7` (`DIFF_FIELDS`)
- Modify: `web/src/pages/admin/dialogs/EditDialog.tsx` (draft + textarea)
- Test: `server/tests/regenerate-story.test.ts`, `web/src/__tests__/admin-dialogs.test.tsx`

**Interfaces:**
- Consumes: `ArticleContent` with `'audioScript'` (Task 1); prompts producing it (Task 2).
- Produces: `PATCH /api/admin/articles/:id` accepts `audioScript`; the regenerate diff lists it.

- [ ] **Step 1: Write the failing server test**

In `server/tests/regenerate-story.test.ts`, in the describe covering apply
(the one containing "writes only the ticked ages and leaves the rest alone"):

```ts
  it('writes the regenerated audio script onto the row it replaces', async () => {
    seedStory('r1', [5, 8, 11]);
    // KID_REPLY (top of this file) carries no audioScript; add one for this case.
    const { client } = countingClient(
      JSON.stringify({ ...JSON.parse(KID_REPLY), audioScript: 'A robot went down to the reef.' }),
    );
    const job = await runJob('r1-v5', { client });

    applyRegeneratedVersions(ctx.db, job.id, [5]);

    expect(getKidArticle(ctx.db, 'r1-v5')!.audioScript).toBe('A robot went down to the reef.');
    // Not ticked, so untouched — seedStory writes no script.
    expect(getKidArticle(ctx.db, 'r1-v8')!.audioScript).toBeNull();
  });
```

`seedStory`, `countingClient`, `runJob`, `KID_REPLY` and `applyRegeneratedVersions`
already exist in that file; `getKidArticle` is already imported from `./helpers.js`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run tests/regenerate-story.test.ts -t "audio script"`
Expected: FAIL — `audioScript` is `null`, because `readEdit`/`ArticleContent` never carried it.

- [ ] **Step 3: Accept an edited script on PATCH**

In `server/src/routes/admin/articleActions.ts`, in `readEdit`, beside the
existing `feelingNote` line:

```ts
  // Optional like feelingNote: clearing it is a legitimate edit — an editor
  // who does not want a story spoken empties the box.
  if (body.audioScript !== undefined) changes.audioScript = optionalString(body.audioScript);
```

- [ ] **Step 4: Run the server test**

Run: `cd server && npx vitest run tests/regenerate-story.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing web test**

In `web/src/__tests__/admin-dialogs.test.tsx`, in the edit-dialog describe:

```ts
  it('sends an edited audio script', async () => {
    renderEditDialog({ ...ARTICLE, audioScript: 'Old script.' });

    const box = screen.getByLabelText('Audio script');
    await userEvent.clear(box);
    await userEvent.type(box, 'New spoken version.');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ audioScript: 'New spoken version.' }),
    );
  });
```

Use the render helper and button label already in that file.

- [ ] **Step 6: Run it and watch it fail**

Run: `cd web && npx vitest run src/__tests__/admin-dialogs.test.tsx -t "audio script"`
Expected: FAIL — no element labelled "Audio script".

- [ ] **Step 7: Add the textarea**

In `web/src/pages/admin/dialogs/EditDialog.tsx`, add to the `useState` draft
after `thinkAbout`:

```ts
    audioScript: article.audioScript ?? '',
```

and add this label block after the "Think about" one:

```tsx
        <label className="md:col-span-2 block">
          <span className="text-sm font-bold">Audio script</span>
          <p className="text-xs text-muted-foreground">
            What a child hears on the podcast page. Empty means the story is not spoken.
          </p>
          <textarea
            aria-label="Audio script"
            value={draft.audioScript}
            onChange={(e) => set('audioScript', e.target.value)}
            rows={5}
            className={`mt-1 ${FIELD_CLASS}`}
          />
        </label>
```

- [ ] **Step 8: Show it in the regenerate diff**

In `web/src/pages/admin/dialogs/VersionDiff.tsx`:

```ts
export const DIFF_FIELDS = [
  'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'thinkAbout', 'audioScript', 'feelingNote', 'safety', 'category', 'readingMinutes',
] as const;
```

- [ ] **Step 9: Run both suites**

Run: `cd server && npm test` — expected PASS.
Run: `cd web && npx tsc --noEmit && npm test` — expected clean, 268 passing.

- [ ] **Step 10: Commit**

```bash
git add server/src/routes/admin/articleActions.ts server/tests/regenerate-story.test.ts \
  web/src/pages/admin/dialogs/EditDialog.tsx web/src/pages/admin/dialogs/VersionDiff.tsx \
  web/src/__tests__/admin-dialogs.test.tsx
git commit -m "feat: carry the audio script through regenerate and edit"
```

---

## Task 4: Speak a story with the browser's own voice

**Files:**
- Create: `web/src/lib/useSpeech.ts`
- Test: `web/src/__tests__/use-speech.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function toSentences(text: string): string[];
  export interface Speech {
    supported: boolean;
    speaking: boolean;
    /** Index into `sentences` currently being spoken, or -1. */
    current: number;
    sentences: string[];
    play: () => void;
    stop: () => void;
  }
  export function useSpeech(text: string | null): Speech;
  ```

- [ ] **Step 1: Write the failing tests**

Create `web/src/__tests__/use-speech.test.ts`:

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSentences, useSpeech } from '../lib/useSpeech';

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  constructor(public text: string) {}
}

let queue: FakeUtterance[];

beforeEach(() => {
  queue = [];
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', {
    speak: (u: FakeUtterance) => queue.push(u),
    cancel: () => { queue = []; },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('toSentences', () => {
  it('splits on sentence endings and drops blanks', () => {
    expect(toSentences('One. Two!  Three?   ')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('returns a single chunk when there is no terminator', () => {
    expect(toSentences('no full stop here')).toEqual(['no full stop here']);
  });
});

describe('useSpeech', () => {
  it('queues one utterance per sentence, not one per script', () => {
    // Chrome truncates a single utterance after ~15s, so a whole story spoken
    // as one utterance cuts off mid-word.
    const { result } = renderHook(() => useSpeech('One. Two. Three.'));

    act(() => result.current.play());

    expect(queue.map((u) => u.text)).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('tracks which sentence is being spoken', () => {
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());

    act(() => queue[0].onstart?.());
    expect(result.current.current).toBe(0);
    expect(result.current.speaking).toBe(true);

    act(() => queue[1].onstart?.());
    expect(result.current.current).toBe(1);
  });

  it('clears the highlight when the last sentence ends', () => {
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());
    act(() => queue[1].onstart?.());
    act(() => queue[1].onend?.());

    expect(result.current.current).toBe(-1);
    expect(result.current.speaking).toBe(false);
  });

  it('stop cancels and clears the highlight', () => {
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());
    act(() => queue[0].onstart?.());

    act(() => result.current.stop());

    expect(result.current.current).toBe(-1);
  });

  it('cancels on unmount, so speech does not outlive the page', () => {
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak: (u: FakeUtterance) => queue.push(u), cancel });
    const { result, unmount } = renderHook(() => useSpeech('One.'));
    act(() => result.current.play());

    unmount();

    expect(cancel).toHaveBeenCalled();
  });

  it('reports unsupported when the browser has no speech synthesis', () => {
    vi.unstubAllGlobals();
    const { result } = renderHook(() => useSpeech('One.'));
    expect(result.current.supported).toBe(false);
  });

  it('has nothing to say for a null script', () => {
    const { result } = renderHook(() => useSpeech(null));
    expect(result.current.sentences).toEqual([]);
    act(() => result.current.play());
    expect(queue).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && npx vitest run src/__tests__/use-speech.test.ts`
Expected: FAIL — cannot resolve `../lib/useSpeech`.

- [ ] **Step 3: Write the hook**

Create `web/src/lib/useSpeech.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Speaking a story with the browser's own voice (SpeechSynthesis) — free, no
 * key, no audio files, and nothing leaves the device.
 *
 * Spoken ONE SENTENCE AT A TIME, which is not a style choice: Chrome silently
 * truncates a single utterance after roughly 15 seconds, so a whole story
 * queued as one utterance stops mid-word. Chunking also gives read-along
 * highlighting for free — the chunk boundaries are ours, whereas word-level
 * `onboundary` events are reliable only in Chrome and Edge.
 */

/** The same sentence rule the server's rule-based simplifier uses. */
export function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export interface Speech {
  supported: boolean;
  speaking: boolean;
  /** Index into `sentences` currently being spoken, or -1. */
  current: number;
  sentences: string[];
  play: () => void;
  stop: () => void;
}

export function useSpeech(text: string | null): Speech {
  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance === 'function';

  const sentences = useMemo(() => (text ? toSentences(text) : []), [text]);
  const [current, setCurrent] = useState(-1);
  // The utterance callbacks fire after cancel() too; this tells them to shut up.
  const cancelled = useRef(false);

  const stop = useCallback(() => {
    if (!supported) return;
    cancelled.current = true;
    window.speechSynthesis.cancel();
    setCurrent(-1);
  }, [supported]);

  // The speech queue belongs to the tab, not to this component: without this
  // a story keeps talking after the reader navigates away.
  useEffect(() => stop, [stop]);

  const play = useCallback(() => {
    if (!supported || sentences.length === 0) return;
    window.speechSynthesis.cancel();
    cancelled.current = false;

    sentences.forEach((sentence, index) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.onstart = () => {
        if (!cancelled.current) setCurrent(index);
      };
      utterance.onend = () => {
        if (!cancelled.current && index === sentences.length - 1) setCurrent(-1);
      };
      window.speechSynthesis.speak(utterance);
    });
  }, [supported, sentences]);

  return { supported, speaking: current >= 0, current, sentences, play, stop };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npx vitest run src/__tests__/use-speech.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and run the whole web suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean, 277 passing.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/useSpeech.ts web/src/__tests__/use-speech.test.ts
git commit -m "feat: speak a story with the browser's own voice"
```

---

## Task 5: Play each story on the podcast page

**Files:**
- Modify: `web/src/pages/Podcast.tsx` (segment list only)
- Test: `web/src/__tests__/podcast.test.tsx` (new)

**Interfaces:**
- Consumes: `useSpeech`, `toSentences` (Task 4); `KidArticle.audioScript` (Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

Create `web/src/__tests__/podcast.test.tsx`. Copy `BASE`, `article()`,
`mockFetch()` and `renderIn()` verbatim from
`web/src/__tests__/public-pages.test.tsx:16-32` (they are module-local there,
not exported), add the `FakeUtterance` / `speechSynthesis` stub from Task 4,
and import `Podcast` from `../pages/Podcast`. `mockFetch` takes the payload
directly, so `mockFetch([article({ … })])` is the whole setup. Then:

```ts
  it('shows the stored audio script, not the assembled one', async () => {
    mockFetch([article({ audioScript: 'A robot went down to the reef.' })]);
    renderIn(<Podcast />);

    expect(await screen.findByText(/A robot went down to the reef\./)).toBeInTheDocument();
    expect(screen.queryByText(/Our next story is from/)).not.toBeInTheDocument();
  });

  it('falls back to the assembled script for a story written before audio existed', async () => {
    // Every story published before this feature has audioScript === null, and
    // the page must not go blank for them.
    mockFetch([article({ audioScript: null })]);
    renderIn(<Podcast />);

    expect(await screen.findByText(/Our next story is from/)).toBeInTheDocument();
  });

  it('speaks what it displays', async () => {
    mockFetch([article({ audioScript: 'One. Two.' })]);
    renderIn(<Podcast />);

    await userEvent.click(await screen.findByRole('button', { name: /listen to story 1/i }));

    expect(queue.map((u) => u.text)).toEqual(['One.', 'Two.']);
  });

  it('renders no play button when the browser cannot speak', async () => {
    vi.unstubAllGlobals();
    mockFetch([article({ audioScript: 'One.' })]);
    renderIn(<Podcast />);

    await screen.findByText('One.');
    expect(screen.queryByRole('button', { name: /listen to story/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && npx vitest run src/__tests__/podcast.test.tsx`
Expected: FAIL — no "listen to story" button; the stored script is not rendered.

- [ ] **Step 3: Extract the segment into its own component**

In `web/src/pages/Podcast.tsx`, keep `segmentScript()` exactly as it is — it is
now the fallback — and add above `export function Podcast()`:

```tsx
/**
 * One story, with the script a child hears and a button that speaks it.
 *
 * The script is the STORED `audioScript`, written and reviewed with the story
 * (§2.2: a person reads every word a child sees, and hearing is seeing).
 * `segmentScript` remains only for stories published before that field
 * existed — it recombines approved sentences and nothing more. The rule is:
 * play exactly what is on screen.
 */
function Segment({ article, index }: { article: KidArticle; index: number }) {
  const speech = useSpeech(article.audioScript ?? segmentScript(article));

  return (
    <li className="bg-card rounded-2xl p-5 border border-border shadow-soft">
      <div className="flex items-start gap-3">
        {speech.supported && (
          <button
            onClick={speech.speaking ? speech.stop : speech.play}
            aria-label={
              speech.speaking ? `Stop story ${index + 1}` : `Listen to story ${index + 1}`
            }
            className="w-10 h-10 shrink-0 rounded-full bg-primary text-primary-foreground grid place-items-center shadow-pop"
          >
            {speech.speaking ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
        )}

        <div className="min-w-0">
          <div className="text-xs font-bold text-primary mb-1">Story {index + 1}</div>
          <h3 className="font-display text-lg mb-2">{article.kidHeadline}</h3>
          <p className="text-sm text-foreground/70 leading-relaxed">
            {speech.sentences.map((sentence, i) => (
              <span
                key={i}
                className={i === speech.current ? 'rounded bg-surface-sun px-0.5' : undefined}
              >
                {sentence}{' '}
              </span>
            ))}
          </p>
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Use it in the list**

Replace the `<li>` block inside `articles.map(...)` with:

```tsx
                  {articles.map((article, index) => (
                    <Segment key={article.id} article={article} index={index} />
                  ))}
```

and add the import at the top:

```ts
import { useSpeech } from '../lib/useSpeech';
```

Leave the hero, the placeholder player, the intro card and the closing card
untouched — real episode audio is a later improvement and that player is its
integration point (§3.5).

- [ ] **Step 5: Run the tests**

Run: `cd web && npx vitest run src/__tests__/podcast.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and run the whole web suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean, 281 passing.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/Podcast.tsx web/src/__tests__/podcast.test.tsx
git commit -m "feat: play each story on the podcast page"
```

---

## Task 6: Documentation

**Files:**
- Modify: `README.md` (the pipeline diagram and the `/podcast` row)
- Modify: `docs/superpowers/specs/2026-09-15-audio-script-design.md` (status)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the reader routes table**

In `README.md`, change the `/podcast` row:

```markdown
| `/podcast`   | Daily episode. Each story can be read aloud by the browser; the episode player is still a **placeholder** (§14) |
```

- [ ] **Step 2: Note the script in the pipeline diagram**

In the "How a story reaches a reader" diagram, change the `kid_articles` note:

```
                                (3 versions + a spoken
                                 script, pending_review)
```

- [ ] **Step 3: Mark the spec implemented**

In `docs/superpowers/specs/2026-09-15-audio-script-design.md`, change the
header line to:

```markdown
**Status:** implemented
```

and replace §5's forward-looking wording with the real counts from the final
`npm test` runs on both sides.

- [ ] **Step 4: Run both suites one last time**

Run: `cd server && npm test` — expected PASS.
Run: `cd web && npx tsc --noEmit && npm test` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-15-audio-script-design.md
git commit -m "docs: describe the spoken version of a story"
```

---

## Manual check before opening the PR

Automated tests mock `speechSynthesis`, so they prove the wiring and nothing
about the sound. Once Task 5 is committed:

1. `cd server && npm run dev`, `cd web && npm run dev`.
2. Simplify one story with an LLM key configured, so a real `audioScript` exists.
3. Publish it, open `/podcast`, press play on that story.
4. Confirm: it speaks, the sentence highlights move with the voice, pressing
   again stops it, and navigating away silences it.
5. Confirm a story published before this change still shows its fallback text
   and still plays.

Voice quality is the device's, not ours — good on iOS and macOS, acceptable on
Windows, often robotic on Linux Chrome. That is expected and not a defect.
