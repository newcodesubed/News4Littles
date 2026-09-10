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
    // schema.sql declares kid_articles.originalId ON DELETE RESTRICT, so this
    // orphaning setup step — a raw article gone while its kid_articles rows
    // remain — needs the constraint suspended; the rest of the test still
    // runs under normal foreign-key enforcement.
    ctx.db.pragma('foreign_keys = OFF');
    ctx.db.prepare('DELETE FROM raw_articles WHERE id = ?').run('r1');
    ctx.db.pragma('foreign_keys = ON');

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
