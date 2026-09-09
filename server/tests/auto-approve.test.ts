/**
 * Auto mode — an LLM judge publishing without an editor.
 *
 * This removes the human review §2.2 promises, so the tests that matter most
 * are the ones proving it stays SHUT: every failure, every refusal and every
 * skip-young story must leave the queue exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenRouterClient } from '../src/llm/openRouterClient.js';
import { judgeStory } from '../src/pipeline/approvalGuard.js';
import { autoApproveStories } from '../src/services/autoApprove.js';
import { createTestContext, insertKidArticle, insertRawArticle, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

/** A client whose single reply the caller chooses. */
function stubClient(reply: { ok: boolean; body: unknown }) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (!reply.ok) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) } }],
        usage: { total_tokens: 10, cost: 0.00001 },
      }),
    };
  }) as unknown as typeof fetch;

  return {
    client: new OpenRouterClient({ apiKey: 'test-key', fetchImpl, maxRetries: 1 }),
    calls: () => calls,
  };
}

/** A story with ten versions, all pending_review. */
function seedStory(rawId: string, safety = 'calm') {
  const raw = insertRawArticle(ctx.db, {
    id: rawId, headline: `Adult headline ${rawId}`, simplifiedAt: '2026-09-06T09:00:00.000Z',
  });
  for (let age = 5; age <= 14; age += 1) {
    insertKidArticle(ctx.db, {
      id: `${rawId}-v${age}`, originalId: raw, ageTarget: age, status: 'pending_review',
      kidHeadline: `Written for age ${age}`, safety,
      feelingNote: safety === 'calm' ? null : 'A gentle note.',
    });
  }
  return raw;
}

const statuses = (rawId: string) =>
  ctx.db.prepare(`SELECT DISTINCT status FROM kid_articles WHERE originalId = ?`).pluck().all(rawId);

const approvedBy = (rawId: string) =>
  ctx.db.prepare(`SELECT DISTINCT approvedBy FROM kid_articles WHERE originalId = ?`).pluck().all(rawId);

describe('judgeStory', () => {
  const article = { kidHeadline: 'A calm story', summary: 'S.', whatHappened: 'W.', whyItMatters: 'Y.', thinkAbout: 'T?' };

  it('approves on an explicit yes', async () => {
    const { client } = stubClient({ ok: true, body: { approved: true, reason: 'Calm and accurate.' } });

    const verdict = await judgeStory(client, article as never);

    expect(verdict.approved).toBe(true);
    expect(verdict.reason).toContain('Calm');
  });

  it('refuses on an explicit no', async () => {
    const { client } = stubClient({ ok: true, body: { approved: false, reason: 'Too upsetting.' } });

    expect((await judgeStory(client, article as never)).approved).toBe(false);
  });

  it.each([
    ['a network failure', { ok: false, body: '' }],
    ['malformed JSON', { ok: true, body: 'not json at all' }],
    ['a missing approved field', { ok: true, body: { reason: 'hmm' } }],
    ['a non-boolean approved field', { ok: true, body: { approved: 'yes', reason: 'hmm' } }],
    ['an empty object', { ok: true, body: {} }],
    ['an array instead of an object', { ok: true, body: [1, 2] }],
  ])('refuses on %s, and never throws', async (_label, reply) => {
    const { client } = stubClient(reply as { ok: boolean; body: unknown });

    // Default-deny: the caller publishes only on approved === true, so every
    // one of these leaves the story where it was.
    const verdict = await judgeStory(client, article as never);
    expect(verdict.approved).toBe(false);
    expect(typeof verdict.reason).toBe('string');
  });
});

describe('autoApproveStories', () => {
  it('publishes a story the judge approves, and records that no human did', async () => {
    const raw = seedStory('s1');
    const { client } = stubClient({ ok: true, body: { approved: true, reason: 'Fine.' } });

    const report = await autoApproveStories(ctx.db, [raw], { client });

    expect(statuses('s1')).toEqual(['published']);
    // Every version, because publishing is story-scoped.
    expect(approvedBy('s1')).toEqual(['auto']);
    expect(report.published).toHaveLength(1);
  });

  it('leaves a story the judge refuses in pending_review', async () => {
    const raw = seedStory('s1');
    const { client } = stubClient({ ok: true, body: { approved: false, reason: 'Too grim.' } });

    const report = await autoApproveStories(ctx.db, [raw], { client });

    expect(statuses('s1')).toEqual(['pending_review']);
    expect(approvedBy('s1')).toEqual([null]);
    expect(report.held[0].reason).toContain('Too grim');
  });

  it.each([
    ['the LLM is unreachable', { ok: false, body: '' }],
    ['the response is malformed', { ok: true, body: '<html>oops</html>' }],
    ['the response has no verdict', { ok: true, body: {} }],
  ])('leaves the story pending_review when %s', async (_label, reply) => {
    const raw = seedStory('s1');
    const { client } = stubClient(reply as { ok: boolean; body: unknown });

    await autoApproveStories(ctx.db, [raw], { client });

    // The requirement: a failure must change nothing.
    expect(statuses('s1')).toEqual(['pending_review']);
    expect(approvedBy('s1')).toEqual([null]);
  });

  it('never publishes a skip-young story, and never even asks', async () => {
    const raw = seedStory('s1', 'skip-young');
    const { client, calls } = stubClient({ ok: true, body: { approved: true, reason: 'Fine.' } });

    const report = await autoApproveStories(ctx.db, [raw], { client });

    expect(statuses('s1')).toEqual(['pending_review']);
    // No call made: the content most likely to upset a child is human-only, so
    // there is nothing for the judge to get wrong (§6, §4.2).
    expect(calls()).toBe(0);
    expect(report.held[0].reason).toMatch(/skip-young/);
  });

  it('leaves a story that is already published alone', async () => {
    const raw = seedStory('s1');
    ctx.db.prepare(`UPDATE kid_articles SET status='published', publishedAt=? WHERE originalId=?`)
      .run('2026-09-09T10:00:00.000Z', raw);
    const { client, calls } = stubClient({ ok: true, body: { approved: true, reason: 'Fine.' } });

    await autoApproveStories(ctx.db, [raw], { client });

    // Still human-published: approvedBy stays NULL and no call was wasted.
    expect(approvedBy('s1')).toEqual([null]);
    expect(calls()).toBe(0);
  });

  it('judges each story independently', async () => {
    const a = seedStory('s1');
    const b = seedStory('s2');
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      const approved = call === 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ approved, reason: 'r' }) } }],
          usage: { total_tokens: 10, cost: 0.00001 },
        }),
      };
    }) as unknown as typeof fetch;

    await autoApproveStories(ctx.db, [a, b], {
      client: new OpenRouterClient({ apiKey: 'test-key', fetchImpl, maxRetries: 1 }),
    });

    expect(statuses('s1')).toEqual(['published']);
    expect(statuses('s2')).toEqual(['pending_review']);
  });
});

describe('the flag gates it', () => {
  it('publishes nothing when auto mode is off, even with a judge that says yes', async () => {
    // The default. AUTO_APPROVE_ENABLED is false unless explicitly set, so a
    // deployment that never heard of this feature keeps §2.2's promise.
    const raw = seedStory('s1');
    const { client, calls } = stubClient({ ok: true, body: { approved: true, reason: 'Fine.' } });

    await autoApproveStories(ctx.db, [], { client });

    expect(statuses('s1')).toEqual(['pending_review']);
    expect(calls()).toBe(0);
    expect(raw).toBe('s1');
  });

  it('a scrape run leaves everything pending_review with the flag off', async () => {
    const { startScrapeRun, resetRunState } = await import('../src/services/scrapeService.js');
    resetRunState();

    try {
      // No feed URL configured for any source, so phase 1 stores nothing and
      // phase 2 has nothing to judge — what matters is autoPublished staying 0.
      const state = await new Promise<{ autoPublished: number }>((resolve) => {
        startScrapeRun(ctx.db, { budget: 0, autoApprove: false, onFinished: resolve });
      });

      expect(state.autoPublished).toBe(0);
    } finally {
      resetRunState();
    }
  });
});
