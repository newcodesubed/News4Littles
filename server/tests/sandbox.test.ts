/**
 * Prompt sandbox — PRD §7.
 *
 * The rule under the most scrutiny is §7.4: nothing here may touch production
 * data. Promotion is the single exception, and only for the prompt tables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../src/llm/openRouterClient.js';
import { readVerdict } from '../src/pipeline/promptGuard.js';
import { createPromptRepository } from '../src/db/repositories/promptRepository.js';
import { countRows, createTestContext, insertRawArticle, type TestContext } from './helpers.js';

const GOOD = {
  kidHeadline: 'A robot looked at a reef',
  summary: 'A robot explored a reef.',
  whatHappened: 'It went down with lights.',
  whyItMatters: 'Reefs are homes for sea animals.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'What would you look for?',
  feelingNote: null,
  safety: 'calm',
  contentWarnings: [],
  readingMinutes: 2,
};

const completion = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { total_tokens: 700, cost: 0.00017 },
  model: 'google/gemini-2.5-flash-lite',
});

function stubClient(content: string) {
  return new OpenRouterClient({
    apiKey: 'test-key',
    maxRetries: 0,
    fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => completion(content) }) as unknown as Response) as unknown as typeof fetch,
  });
}

let ctx: TestContext;
let rawId: string;

beforeEach(() => {
  ctx = createTestContext();
  rawId = insertRawArticle(ctx.db, {
    headline: 'Survey team documents a coral reef',
    body: 'A rover surveyed the reef at nine hundred metres.',
  });
});
afterEach(() => ctx.close());

const post = (path: string, body: unknown) =>
  ctx.api(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
  ctx.api(path, { method: 'PUT', body: JSON.stringify(body) });

describe('auth (§7.6)', () => {
  it.each([
    ['GET', '/api/admin/prompts'],
    ['GET', '/api/admin/prompts/versions'],
    ['GET', '/api/admin/raw-articles'],
    ['PUT', '/api/admin/prompts/draft'],
    ['POST', '/api/admin/prompts/test'],
    ['POST', '/api/admin/prompts/promote'],
  ])('%s %s requires admin auth', async (method, path) => {
    expect((await ctx.anon(path, { method })).status).toBe(401);
  });
});

describe('GET /prompts', () => {
  it('returns the live prompts, drafts, versions and template variables', async () => {
    const body = await (await ctx.api('/api/admin/prompts')).json();
    expect(body.simplification.generic).toContain('rewriting a real news story');
    expect(body.simplification.ageOverrides['6']).toBeTruthy();
    expect(body.templateVariables).toContain('{{headline}}');
    expect(body.versions).toEqual({});
    expect(body.drafts).toEqual([]);
  });

  it('says whether an LLM is configured (§7.4)', async () => {
    const body = await (await ctx.api('/api/admin/prompts')).json();
    // Tests force LLM_ENABLED=false, so the sandbox must report that honestly.
    expect(body.llm.enabled).toBe(false);
    expect(body.llm.model).toBeTruthy();
  });
});

describe('GET /raw-articles (§7.6)', () => {
  it('lists recent articles for the dropdown, newest first', async () => {
    insertRawArticle(ctx.db, { headline: 'Newer story', fetchedAt: '2026-09-09T10:00:00.000Z' });
    const rows = await (await ctx.api('/api/admin/raw-articles')).json();
    expect(rows[0].headline).toBe('Newer story');
    expect(rows[0]).toHaveProperty('bodyLength');
  });

  it('caps the limit', async () => {
    expect((await (await ctx.api('/api/admin/raw-articles?limit=9999')).json()).length).toBeLessThanOrEqual(100);
  });
});

describe('drafts (§7.4: a draft never affects production)', () => {
  it('saves and lists a draft', async () => {
    await put('/api/admin/prompts/draft', { target: 'simplification', age: 8, promptText: 'My draft' });
    const body = await (await ctx.api('/api/admin/prompts')).json();
    expect(body.drafts).toEqual([
      expect.objectContaining({ target: 'simplification', age: 8, promptText: 'My draft' }),
    ]);
  });

  it('leaves the production prompt untouched', async () => {
    const before = await (await ctx.api('/api/admin/prompts')).json();
    await put('/api/admin/prompts/draft', { target: 'simplification', age: null, promptText: 'My draft' });
    const after = await (await ctx.api('/api/admin/prompts')).json();
    expect(after.simplification.generic).toBe(before.simplification.generic);
  });

  it('keeps one draft per target+age, overwriting on re-save', async () => {
    await put('/api/admin/prompts/draft', { target: 'simplification', age: null, promptText: 'first' });
    await put('/api/admin/prompts/draft', { target: 'simplification', age: null, promptText: 'second' });
    const { drafts } = await (await ctx.api('/api/admin/prompts')).json();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].promptText).toBe('second');
  });

  it('keeps generic and per-age drafts apart', async () => {
    await put('/api/admin/prompts/draft', { target: 'simplification', age: null, promptText: 'generic' });
    await put('/api/admin/prompts/draft', { target: 'simplification', age: 8, promptText: 'age eight' });
    expect((await (await ctx.api('/api/admin/prompts')).json()).drafts).toHaveLength(2);
  });

  it('refuses an age on the guard prompt (§7.3)', async () => {
    expect((await put('/api/admin/prompts/draft', { target: 'guard', age: 8, promptText: 'x' })).status).toBe(400);
  });

  it.each([
    ['an unknown target', { target: 'nonsense', promptText: 'x' }],
    ['an out-of-range age', { target: 'simplification', age: 99, promptText: 'x' }],
    ['an empty prompt', { target: 'simplification', promptText: '  ' }],
  ])('rejects %s', async (_label, body) => {
    expect((await put('/api/admin/prompts/draft', body)).status).toBe(400);
  });

  it('deletes a draft', async () => {
    await put('/api/admin/prompts/draft', { target: 'simplification', age: null, promptText: 'x' });
    await ctx.api('/api/admin/prompts/draft?target=simplification', { method: 'DELETE' });
    expect((await (await ctx.api('/api/admin/prompts')).json()).drafts).toEqual([]);
  });
});

describe('POST /prompts/test — §7.4: writes nothing', () => {
  const testBody = (extra = {}) => ({
    target: 'simplification', age: 8, promptText: 'Rewrite {{headline}} for {{age}}.',
    articleId: rawId, ...extra,
  });

  it('runs against a stored article and returns a rendered result', async () => {
    const body = await (await post('/api/admin/prompts/test', testBody())).json();
    expect(body.subject.headline).toBe('Survey team documents a coral reef');
    expect(body.draft.article.kidHeadline).toBeTruthy();
  });

  it('writes NOTHING to production tables', async () => {
    const before = {
      raw: countRows(ctx.db, 'raw_articles'),
      kid: countRows(ctx.db, 'kid_articles'),
      prompts: (await (await ctx.api('/api/admin/prompts')).json()).simplification.generic,
    };

    await post('/api/admin/prompts/test', testBody({ compareWithProduction: true }));

    expect(countRows(ctx.db, 'raw_articles')).toBe(before.raw);
    expect(countRows(ctx.db, 'kid_articles')).toBe(before.kid);
    expect((await (await ctx.api('/api/admin/prompts')).json()).simplification.generic).toBe(before.prompts);
  });

  it('accepts pasted text instead of a stored article', async () => {
    const body = await (await post('/api/admin/prompts/test', {
      target: 'simplification', promptText: 'p', rawText: 'A volcano erupted near the town.',
      headline: 'Volcano erupts',
    })).json();
    expect(body.subject.headline).toBe('Volcano erupts');
    expect(countRows(ctx.db, 'raw_articles')).toBe(1); // the fixture only
  });

  it('404s for an unknown article id', async () => {
    expect((await post('/api/admin/prompts/test', testBody({ articleId: 'ghost' }))).status).toBe(404);
  });

  it('400s when given neither an article nor text', async () => {
    expect((await post('/api/admin/prompts/test', { target: 'simplification', promptText: 'p' })).status).toBe(400);
  });

  it('reports the words-per-sentence check against the age limit (§7.3)', async () => {
    const body = await (await post('/api/admin/prompts/test', testBody({ age: 6 }))).json();
    expect(body.draft.validation.ageLimit).toBe(14);
    expect(typeof body.draft.validation.longestSentenceWords).toBe('number');
    expect(typeof body.draft.validation.withinAgeLimit).toBe('boolean');
  });

  it('comparison mode returns both runs (§7.3)', async () => {
    const body = await (await post('/api/admin/prompts/test', testBody({ compareWithProduction: true }))).json();
    expect(body.draft.article).toBeTruthy();
    expect(body.production.article).toBeTruthy();
  });

  it('omits the production run when not asked for', async () => {
    const body = await (await post('/api/admin/prompts/test', testBody())).json();
    expect(body.production).toBeUndefined();
  });

  it('says when it fell back to the local pipeline (§7.4)', async () => {
    const body = await (await post('/api/admin/prompts/test', testBody())).json();
    // LLM_ENABLED is false in tests, so every run is the local fallback.
    expect(body.usingLocalFallback).toBe(true);
    expect(body.draft.engine).toBe('local-fallback');
  });
});

describe('promotion (§7.4, §7.5)', () => {
  const promote = (extra = {}) =>
    post('/api/admin/prompts/promote', {
      target: 'simplification', age: null, promptText: 'A promoted prompt',
      confirmed: true, note: 'Better safety wording', ...extra,
    });

  it('refuses without confirmation', async () => {
    const res = await promote({ confirmed: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/confirmed/);
  });

  it('writes the production prompt', async () => {
    await promote();
    expect((await (await ctx.api('/api/admin/prompts')).json()).simplification.generic)
      .toBe('A promoted prompt');
  });

  it('records an immutable version with who, when and the note', async () => {
    const record = await (await promote()).json();
    expect(record).toMatchObject({
      target: 'simplification', age: null, version: 1,
      promotedBy: 'admin', note: 'Better safety wording',
    });
    expect(record.promotedAt).toBeTruthy();
  });

  it('increments the version per target+age (§7.5)', async () => {
    expect((await (await promote()).json()).version).toBe(1);
    expect((await (await promote()).json()).version).toBe(2);
    // A different age keeps its own counter.
    expect((await (await promote({ age: 8 })).json()).version).toBe(1);
  });

  it('updates the version summary shown in settings', async () => {
    await promote();
    await promote({ age: 8 });
    const { versions } = await (await ctx.api('/api/admin/prompts')).json();
    expect(versions).toMatchObject({ simplification: 1, 'simplification:8': 1 });
  });

  it('writes an age override without disturbing the generic prompt', async () => {
    const before = (await (await ctx.api('/api/admin/prompts')).json()).simplification.generic;
    await promote({ age: 8, promptText: 'Age eight prompt' });
    const after = await (await ctx.api('/api/admin/prompts')).json();
    expect(after.simplification.ageOverrides['8']).toBe('Age eight prompt');
    expect(after.simplification.generic).toBe(before);
  });

  it('promoting the guard prompt updates the guard config', async () => {
    await promote({ target: 'guard', age: null, promptText: 'Classify this story.' });
    expect((await (await ctx.api('/api/admin/prompts')).json()).guard.promptText).toBe('Classify this story.');
  });

  it('clears the draft that has now landed (§7.4)', async () => {
    await put('/api/admin/prompts/draft', { target: 'simplification', age: null, promptText: 'A promoted prompt' });
    await promote();
    expect((await (await ctx.api('/api/admin/prompts')).json()).drafts).toEqual([]);
  });

  it('does NOT regenerate existing pending articles (§7.4)', async () => {
    const before = countRows(ctx.db, 'kid_articles');
    await promote();
    expect(countRows(ctx.db, 'kid_articles')).toBe(before);
  });

  it('refuses an empty prompt', async () => {
    expect((await promote({ promptText: '   ' })).status).toBe(400);
  });
});

describe('version history (§7.5)', () => {
  it('lists newest first and filters by target', async () => {
    await post('/api/admin/prompts/promote', { target: 'simplification', promptText: 'v1', confirmed: true });
    await post('/api/admin/prompts/promote', { target: 'guard', promptText: 'g1', confirmed: true });

    const all = await (await ctx.api('/api/admin/prompts/versions')).json();
    expect(all).toHaveLength(2);

    const guards = await (await ctx.api('/api/admin/prompts/versions?target=guard')).json();
    expect(guards).toHaveLength(1);
    expect(guards[0].promptText).toBe('g1');
  });

  it('keeps every promoted text, so any two can be diffed', async () => {
    await post('/api/admin/prompts/promote', { target: 'simplification', promptText: 'first', confirmed: true });
    await post('/api/admin/prompts/promote', { target: 'simplification', promptText: 'second', confirmed: true });

    const versions = await (await ctx.api('/api/admin/prompts/versions?target=simplification')).json();
    expect(versions.map((v: any) => v.promptText).sort()).toEqual(['first', 'second']);
  });
});

describe('GET /prompts/production — the "reset to production" source', () => {
  it('returns the generic prompt when no age is given', async () => {
    const body = await (await ctx.api('/api/admin/prompts/production?target=simplification')).json();
    expect(body.promptText).toContain('rewriting a real news story');
  });

  it('returns the age override when one exists', async () => {
    const body = await (await ctx.api('/api/admin/prompts/production?target=simplification&age=6')).json();
    expect(body.promptText).toContain('6-year-old');
  });

  it('falls back to generic for an age with no override', async () => {
    const generic = (await (await ctx.api('/api/admin/prompts/production?target=simplification')).json()).promptText;
    const age11 = (await (await ctx.api('/api/admin/prompts/production?target=simplification&age=11')).json()).promptText;
    expect(age11).toBe(generic);
  });
});

describe('guard verdict parsing (§6.2)', () => {
  it.each([
    ['{"safety":"safe"}', 'calm'],
    ['{"safety":"skip"}', 'skip-young'],
    ['{"safety":"adult-nearby"}', 'adult-nearby'],
    ['{"safety":"calm"}', 'calm'],
    ['safe', 'calm'],
    ['The verdict is skip.', 'skip-young'],
    ['adult-nearby', 'adult-nearby'],
  ])('reads %s as %s', (text, expected) => expect(readVerdict(text)).toBe(expected));

  it('reads skip-young without mistaking it for skip', () => {
    expect(readVerdict('skip-young')).toBe('skip-young');
  });

  it('returns nothing for an unreadable answer, rather than guessing', () => {
    expect(readVerdict('I am not sure about this one')).toBeUndefined();
  });
});

describe('guard target end to end', () => {
  it('runs the guard prompt and returns its raw response (§7.3)', async () => {
    const { runSandboxTest } = await import('../src/services/sandbox.js');
    const result = await runSandboxTest(ctx.db, {
      target: 'guard', age: null, promptText: 'Classify {{headline}}',
      subject: { articleId: rawId },
      client: stubClient('{"safety":"skip"}'),
    });
    expect(result.draft.guardVerdict).toBe('skip-young');
    expect(result.draft.guardRaw).toBe('{"safety":"skip"}');
  });

  it('reports an unreadable verdict instead of inventing one', async () => {
    const { runSandboxTest } = await import('../src/services/sandbox.js');
    const result = await runSandboxTest(ctx.db, {
      target: 'guard', age: null, promptText: 'Classify it',
      subject: { articleId: rawId },
      client: stubClient('no idea'),
    });
    expect(result.draft.guardVerdict).toBeUndefined();
    expect(result.draft.fallbackReason).toMatch(/recognisable verdict/);
  });
});

describe('the draft/version tables keep their Phase 1 guarantees', () => {
  it('one draft per target+age, NULL age included', () => {
    const repo = createPromptRepository(ctx.db);
    const now = '2026-09-09T10:00:00.000Z';
    repo.saveDraft({ target: 'simplification', age: null, promptText: 'a' }, now);
    repo.saveDraft({ target: 'simplification', age: null, promptText: 'b' }, now);
    expect(repo.listDrafts()).toHaveLength(1);
    expect(repo.listDrafts()[0].promptText).toBe('b');
  });

  it('version numbers are monotonic per target+age', () => {
    const repo = createPromptRepository(ctx.db);
    const now = '2026-09-09T10:00:00.000Z';
    const promote = (age: number | null) =>
      repo.recordPromotion({ target: 'simplification', age, promptText: 'p', promotedBy: 'admin', note: null }, now);

    expect(promote(null).version).toBe(1);
    expect(promote(null).version).toBe(2);
    expect(promote(8).version).toBe(1);
  });
});
