/**
 * LLM simplification — PRD §9.1.
 *
 * All offline: the provider is a stub. The rules that matter are that a bad
 * response never reaches the database, and that the guard's verdict beats the
 * model's (§6 "the strictest result wins").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, stripCodeFence } from '../src/llm/openRouterClient.js';
import { parseLlmContent, renderPrompt, selectPrompt, LlmResponseError } from '../src/llm/llmSimplifier.js';
import { simplifyArticle } from '../src/pipeline/simplifyArticle.js';
import { AGE_6_SIMPLIFICATION_PROMPT, GENERIC_SIMPLIFICATION_PROMPT } from '../src/db/seed-prompts.js';
import { createTestContext, type TestContext } from './helpers.js';

const RAW = {
  id: 'r1',
  headline: 'Council approves reef plan',
  body: 'A rover surveyed the reef. Officials agreed a treaty.',
  topic: 'Environment',
  sourceName: 'BBC News',
  sourceUrl: 'https://example.com/a',
};

const GOOD = {
  kidHeadline: 'A robot went to look at a reef',
  summary: 'A robot explored a reef under the sea.',
  whatHappened: 'A robot with lights went down to the reef.',
  whyItMatters: 'Reefs are home to lots of sea animals.',
  vocab: [{ word: 'reef', definition: 'A ridge of rock under the sea.' }],
  thinkAbout: 'What would you look for down there?',
  feelingNote: null,
  safety: 'calm',
  contentWarnings: [],
  readingMinutes: 3,
};

/** A stub provider returning whatever body the test wants. */
function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as Response);
}

const completion = (content: string, cost = 0.00017) => ({
  choices: [{ message: { content } }],
  usage: { total_tokens: 800, cost },
  model: 'google/gemini-2.5-flash-lite',
});

describe('stripCodeFence', () => {
  it.each([
    ['```json\n{"a":1}\n```', '{"a":1}'],
    ['```\n{"a":1}\n```', '{"a":1}'],
    ['  {"a":1}  ', '{"a":1}'],
    ['{"a":1}', '{"a":1}'],
  ])('%s -> %s', (input, expected) => expect(stripCodeFence(input)).toBe(expected));

  it('leaves a fence-free multi-line object alone', () => {
    expect(stripCodeFence('{\n "a": 1\n}')).toBe('{\n "a": 1\n}');
  });
});

describe('prompt selection (§9.1 step 1)', () => {
  it('prefers an age override', () => {
    expect(selectPrompt('generic', { '6': 'age six' }, 6)).toEqual({ template: 'age six', source: 'age-6' });
  });

  it('falls back to generic when no override exists', () => {
    expect(selectPrompt('generic', { '6': 'age six' }, 9).template).toBe('generic');
  });

  it('ignores a blank override', () => {
    expect(selectPrompt('generic', { '6': '   ' }, 6).template).toBe('generic');
  });
});

describe('prompt rendering (§7.3 variables)', () => {
  const context = { headline: 'H', body: 'B', category: 'C', sourceName: 'S', age: 8 };

  it('substitutes every variable', () => {
    const out = renderPrompt('{{headline}}|{{body}}|{{category}}|{{sourceName}}|{{age}}', context);
    expect(out).toBe('H|B|C|S|8');
  });

  it('substitutes repeated variables', () => {
    expect(renderPrompt('{{age}} and {{age}}', context)).toBe('8 and 8');
  });

  it('truncates the body, so one huge paste cannot run up a bill', () => {
    const out = renderPrompt('{{body}}', { ...context, body: 'x'.repeat(10_000) }, 100);
    expect(out).toHaveLength(100 + '…[truncated]'.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });
});

describe('response validation', () => {
  it('accepts a well-formed response', () => {
    expect(parseLlmContent(JSON.stringify(GOOD)).kidHeadline).toBe(GOOD.kidHeadline);
  });

  it.each([
    ['not JSON at all', 'hello'],
    ['a JSON array', '[1,2]'],
    ['a bare string', '"hello"'],
    ['a missing headline', JSON.stringify({ ...GOOD, kidHeadline: undefined })],
    ['an empty headline', JSON.stringify({ ...GOOD, kidHeadline: '   ' })],
    ['an unknown safety level', JSON.stringify({ ...GOOD, safety: 'scary' })],
    ['a missing safety level', JSON.stringify({ ...GOOD, safety: undefined })],
  ])('rejects %s', (_label, text) => {
    expect(() => parseLlmContent(text)).toThrow(LlmResponseError);
  });

  it('drops malformed vocab entries instead of losing the article', () => {
    const content = parseLlmContent(JSON.stringify({
      ...GOOD,
      vocab: [{ word: 'reef', definition: 'ok' }, { word: '' }, 'nonsense', { definition: 'no word' }],
    }));
    expect(content.vocab).toEqual([{ word: 'reef', definition: 'ok' }]);
  });

  it('caps vocab at four entries', () => {
    const vocab = Array.from({ length: 9 }, (_, i) => ({ word: `w${i}`, definition: 'd' }));
    expect(parseLlmContent(JSON.stringify({ ...GOOD, vocab })).vocab).toHaveLength(4);
  });

  it('clamps readingMinutes to satisfy the schema CHECK', () => {
    for (const value of [0, -3, 'abc', undefined]) {
      expect(parseLlmContent(JSON.stringify({ ...GOOD, readingMinutes: value })).readingMinutes).toBeGreaterThanOrEqual(1);
    }
  });

  it('normalises empty contentWarnings to null', () => {
    expect(parseLlmContent(JSON.stringify({ ...GOOD, contentWarnings: [] })).contentWarnings).toBeNull();
  });
});

describe('OpenRouterClient', () => {
  const client = (fetchImpl: typeof fetch, overrides = {}) =>
    new OpenRouterClient({ apiKey: 'test-key', fetchImpl, maxRetries: 1, ...overrides });

  it('returns the content on success', async () => {
    const result = await client(stubFetch(completion('{"a":1}')) as unknown as typeof fetch).complete({ prompt: 'p' });
    expect(result).toMatchObject({ ok: true, text: '{"a":1}', totalTokens: 800, costUsd: 0.00017 });
  });

  it('strips a code fence from the content', async () => {
    const result = await client(stubFetch(completion('```json\n{"a":1}\n```')) as unknown as typeof fetch).complete({ prompt: 'p' });
    expect(result.ok && result.text).toBe('{"a":1}');
  });

  it('treats empty content as a failure, not a success', async () => {
    // A reasoning model can spend its whole budget thinking; gpt-5-nano does.
    const result = await client(stubFetch(completion('')) as unknown as typeof fetch).complete({ prompt: 'p' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no content/);
  });

  it('reports a missing key without calling out', async () => {
    const fetchImpl = stubFetch(completion('{}'));
    const result = await new OpenRouterClient({ apiKey: '', fetchImpl: fetchImpl as unknown as typeof fetch })
      .complete({ prompt: 'p' });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a 429 once, then gives up', async () => {
    const fetchImpl = stubFetch({ error: { message: 'rate limited' } }, 429);
    const result = await client(fetchImpl as unknown as typeof fetch).complete({ prompt: 'p' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.transient).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one attempt + one retry
  });

  it('does NOT retry a 400, so a bad request is not paid for twice', async () => {
    const fetchImpl = stubFetch({ error: { message: 'bad model' } }, 400);
    await client(fetchImpl as unknown as typeof fetch).complete({ prompt: 'p' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces the provider message', async () => {
    const result = await client(stubFetch({ error: { message: 'model not found' } }, 404) as unknown as typeof fetch)
      .complete({ prompt: 'p' });
    expect(result.ok === false && result.reason).toContain('model not found');
  });

  it('never leaks the key in a failure message', async () => {
    const result = await client(stubFetch({ error: { message: 'nope' } }, 500) as unknown as typeof fetch)
      .complete({ prompt: 'p' });
    expect(JSON.stringify(result)).not.toContain('test-key');
  });

  it('reports an unreachable provider as transient', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const result = await client(fetchImpl as unknown as typeof fetch).complete({ prompt: 'p' });
    expect(result.ok === false && result.transient).toBe(true);
  });

  it('caps max_tokens on the request', async () => {
    const fetchImpl = stubFetch(completion('{"a":1}'));
    await client(fetchImpl as unknown as typeof fetch, { maxTokens: 42 }).complete({ prompt: 'p' });
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]!.body));
    expect(body.max_tokens).toBe(42);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('simplifyArticle orchestration', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { ctx.close(); vi.unstubAllGlobals(); });

  const withClient = (body: unknown, status = 200) =>
    new OpenRouterClient({
      apiKey: 'test-key',
      fetchImpl: stubFetch(body, status) as unknown as typeof fetch,
      maxRetries: 0,
    });

  it('uses the LLM output when the response is good', async () => {
    const out = await simplifyArticle(ctx.db, RAW, { client: withClient(completion(JSON.stringify(GOOD))), ageTarget: 8 });
    expect(out.engine).toBe('llm');
    expect(out.article.kidHeadline).toBe(GOOD.kidHeadline);
    expect(out.costUsd).toBe(0.00017);
  });

  it('falls back and flags the reason when the provider fails', async () => {
    const out = await simplifyArticle(ctx.db, RAW, { client: withClient({ error: { message: 'boom' } }, 500), ageTarget: 8 });
    expect(out.engine).toBe('local-fallback');
    expect(out.fallbackReason).toContain('boom');
    expect(out.article.kidHeadline.length).toBeGreaterThan(0);
  });

  it('falls back when the response is unparseable (§9.1 step 4)', async () => {
    const out = await simplifyArticle(ctx.db, RAW, { client: withClient(completion('not json')), ageTarget: 8 });
    expect(out.engine).toBe('local-fallback');
    expect(out.fallbackReason).toMatch(/not valid JSON/);
  });

  it('forceLocal skips the provider entirely', async () => {
    const fetchImpl = stubFetch(completion(JSON.stringify(GOOD)));
    const out = await simplifyArticle(ctx.db, RAW, {
      client: new OpenRouterClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }),
      forceLocal: true,
    });
    expect(out.engine).toBe('local-fallback');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never auto-publishes, whichever engine ran (§5.2 step 7)', async () => {
    const out = await simplifyArticle(ctx.db, RAW, { client: withClient(completion(JSON.stringify(GOOD))) });
    expect(out.article.status).toBe('pending_review');
    expect(out.article.publishedAt).toBeNull();
  });

  describe('§6: the guard beats the model', () => {
    const WAR = { ...RAW, body: 'There was a war, an attack and a bomb near the border.' };

    it('a model calling a war story "calm" cannot publish it as calm', async () => {
      const out = await simplifyArticle(ctx.db, WAR, {
        client: withClient(completion(JSON.stringify({ ...GOOD, safety: 'calm', feelingNote: null }))),
      });
      expect(out.engine).toBe('llm');
      // Three deny-list terms -> skip-young, and that wins.
      expect(out.article.safety).toBe('skip-young');
    });

    it('the raised level still gets a feeling note (§3.4)', async () => {
      const out = await simplifyArticle(ctx.db, WAR, {
        client: withClient(completion(JSON.stringify({ ...GOOD, safety: 'calm', feelingNote: null }))),
      });
      expect(out.article.feelingNote).toBeTruthy();
    });

    it('the deny-list terms become content warnings', async () => {
      const out = await simplifyArticle(ctx.db, WAR, {
        client: withClient(completion(JSON.stringify({ ...GOOD, safety: 'calm', contentWarnings: [] }))),
      });
      expect(out.article.contentWarnings).toEqual(['war', 'attack', 'bomb']);
    });

    it('a model stricter than the deny-list still wins', async () => {
      const out = await simplifyArticle(ctx.db, RAW, {
        client: withClient(completion(JSON.stringify({ ...GOOD, safety: 'skip-young', feelingNote: 'Careful.' }))),
      });
      expect(out.article.safety).toBe('skip-young');
      expect(out.article.feelingNote).toBe('Careful.');
    });

    it('a calm story from a calm model stays calm with no note', async () => {
      const out = await simplifyArticle(ctx.db, RAW, {
        client: withClient(completion(JSON.stringify(GOOD))),
      });
      expect(out.article.safety).toBe('calm');
      expect(out.article.feelingNote).toBeNull();
    });
  });

  it('falls back when no prompt is configured', async () => {
    // Both must go: the seed ships an age-6 override, and 6 is the default age.
    ctx.db.prepare(
      `UPDATE translation_prompt_config SET genericPrompt = '', ageOverrides = '{}' WHERE id='default'`,
    ).run();
    const out = await simplifyArticle(ctx.db, RAW, { client: withClient(completion(JSON.stringify(GOOD))) });
    expect(out.engine).toBe('local-fallback');
    expect(out.fallbackReason).toMatch(/No prompt/);
  });

  it('reports which prompt was used', async () => {
    const out = await simplifyArticle(ctx.db, RAW, {
      client: withClient(completion(JSON.stringify(GOOD))), ageTarget: 6,
    });
    // The seed ships an age-6 override.
    expect(out.promptSource).toBe('age-6');
  });
});

describe('the seeded prompts must keep their safety criteria', () => {
  /**
   * With only a three-line description of the levels, a real model rated a
   * story about four people killed and eleven wounded as "calm". These
   * assertions stop that guidance being dropped by accident.
   */
  it.each([
    ['generic', GENERIC_SIMPLIFICATION_PROMPT],
    ['age-6', AGE_6_SIMPLIFICATION_PROMPT],
  ])('%s prompt tells the model to judge the subject, not its own rewrite', (_label, prompt) => {
    expect(prompt).toContain('Judge the SUBJECT of the story');
  });

  it.each([
    ['generic', GENERIC_SIMPLIFICATION_PROMPT],
    ['age-6', AGE_6_SIMPLIFICATION_PROMPT],
  ])('%s prompt names the skip-young triggers from §6.1', (_label, prompt) => {
    for (const trigger of ['war', 'killing', 'attack', 'violence']) {
      expect(prompt.toLowerCase()).toContain(trigger);
    }
  });

  it.each([
    ['generic', GENERIC_SIMPLIFICATION_PROMPT],
    ['age-6', AGE_6_SIMPLIFICATION_PROMPT],
  ])('%s prompt biases towards the stricter level when unsure', (_label, prompt) => {
    expect(prompt).toContain('choose the STRICTER one');
  });

  it('generic prompt forbids proper nouns as vocabulary', () => {
    // It picked "Volkswagen, Audi, Porsche, Skoda" as words to know.
    expect(GENERIC_SIMPLIFICATION_PROMPT).toContain('Never proper');
  });
});
