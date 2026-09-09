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
import { simplifyArticle, simplifyArticleForAllAges } from '../src/pipeline/simplifyArticle.js';
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

describe('sharing one prompt-guard verdict across ages', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => ctx.close());

  const RAW_INPUT = {
    id: 'r1', headline: 'A reef was surveyed', body: 'A rover surveyed the reef today.',
    topic: 'World', sourceName: 'BBC News', sourceUrl: 'https://example.com/a',
  };

  const GOOD_REPLY = JSON.stringify({
    kidHeadline: 'A reef was looked at', summary: 'Divers looked at a reef.',
    whatHappened: 'They went down deep.', whyItMatters: 'Reefs matter.',
    thinkAbout: 'What lives on a reef?', safety: 'calm', readingMinutes: 2,
    vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  });

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

  const enableGuard = () =>
    ctx.db.prepare(
      `UPDATE guard_config SET promptGuardEnabled = 1, promptGuardText = 'Classify: {{body}}'
       WHERE id = 'default'`,
    ).run();

  it('makes its own guard call when none is supplied', async () => {
    enableGuard();
    const { client, calls } = countingClient(GOOD_REPLY);

    await simplifyArticle(ctx.db, RAW_INPUT, { ageTarget: 8, client });

    // One guard call plus one simplification call.
    expect(calls()).toBe(2);
  });

  it('uses a supplied verdict instead of calling the guard again', async () => {
    enableGuard();
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

  /**
   * A client whose reply is decided by the PROMPT it receives, not by the call
   * index: a 500 is transient, so the client retries it and a call-index rule
   * would see the retry succeed. Keying on the prompt fails every attempt for
   * that age, which is what "this age fell back" actually means.
   *
   * `usage.cost` is set because that is the only field costUsd is read from.
   */
  function scriptedClient(replyFor: (prompt: string) => { ok: boolean; body: string }) {
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls += 1;
      const prompt = JSON.parse(String(init.body)).messages[0].content as string;
      const { ok, body } = replyFor(prompt);
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () =>
          ok
            ? {
                choices: [{ message: { content: body } }],
                usage: { total_tokens: 10, cost: 0.00002 },
              }
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
    // Every attempt for age 7 fails; the other nine ages succeed. The seeded
    // generic prompt renders "{{age}}-year-old", so the age is in the prompt.
    const { client } = scriptedClient((prompt) =>
      prompt.includes('7-year-old')
        ? { ok: false, body: 'upstream exploded' }
        : { ok: true, body: reply('A kid headline') },
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
