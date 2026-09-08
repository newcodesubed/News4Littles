/**
 * Manual "Run now" scraping — PRD §4.4.
 *
 * The feed is served locally, so these never touch the network.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createScrapeRunRepository } from '../src/db/repositories/scrapeRunRepository.js';
import { getRunState, resetRunState, startScrapeRun, summarise } from '../src/services/scrapeService.js';
import { countRows, createTestContext, type TestContext } from './helpers.js';

let feedStatus = 200;
let itemCount = 2;
/** Holds the feed response open, so a run can be observed mid-flight. */
let feedDelayMs = 0;
let feedServer: Server;
let feedUrl: string;

function rss(count: number): string {
  const items = Array.from({ length: count }, (_, i) => `<item>
    <title><![CDATA[Story number ${i + 1}]]></title>
    <link>https://example.com/story-${i + 1}</link>
    <pubDate>${new Date(Date.UTC(2026, 8, 9, 10, i)).toUTCString()}</pubDate>
    <description><![CDATA[A calm story about the sea.]]></description>
  </item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
    <link>https://example.com</link><description>d</description>${items}</channel></rss>`;
}

beforeAll(async () => {
  feedServer = createServer((_req, res) => {
    const reply = () => {
      if (feedStatus !== 200) { res.writeHead(feedStatus); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(rss(itemCount));
    };
    if (feedDelayMs > 0) setTimeout(reply, feedDelayMs);
    else reply();
  });
  feedServer.listen(0);
  await new Promise((r) => feedServer.once('listening', r));
  feedUrl = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/rss.xml`;
});
afterAll(() => feedServer.close());

let ctx: TestContext;

/** Resolves once the in-flight run has finished. */
const waitForRun = () =>
  new Promise<void>((resolve) => {
    const tick = () => (getRunState()?.running ? setTimeout(tick, 10) : resolve());
    tick();
  });

beforeEach(() => {
  resetRunState();
  feedStatus = 200;
  itemCount = 2;
  feedDelayMs = 0;
  ctx = createTestContext();
  ctx.db.prepare(`UPDATE sources SET url = ? WHERE id = 'bbc'`).run(feedUrl);
  // Only BBC is enabled by default, so "all sources" means one feed here.
});
afterEach(() => { resetRunState(); ctx.close(); });

describe('starting a run', () => {
  it('returns immediately rather than holding the request open', async () => {
    const started = Date.now();
    const state = startScrapeRun(ctx.db);
    expect(Date.now() - started).toBeLessThan(50);
    expect(state.running).toBe(true);
    await waitForRun();
  });

  it('scrapes every enabled source', async () => {
    startScrapeRun(ctx.db);
    await waitForRun();
    expect(getRunState()!.results.map((r) => r.sourceId)).toEqual(['bbc']);
    expect(countRows(ctx.db, 'kid_articles')).toBe(2);
  });

  it('scrapes one named source', async () => {
    startScrapeRun(ctx.db, { sourceId: 'bbc' });
    await waitForRun();
    expect(getRunState()!.sourceIds).toEqual(['bbc']);
  });

  it('runs a disabled source when named, because the editor asked', async () => {
    ctx.db.prepare(`UPDATE sources SET enabled = 0 WHERE id = 'bbc'`).run();
    startScrapeRun(ctx.db, { sourceId: 'bbc' });
    await waitForRun();
    expect(getRunState()!.results).toHaveLength(1);
  });

  it('404s for an unknown source', () => {
    expect(() => startScrapeRun(ctx.db, { sourceId: 'ghost' })).toThrow(/No source with id/);
  });

  it('refuses a second run while one is in flight', async () => {
    feedDelayMs = 300;
    startScrapeRun(ctx.db);
    // A concurrent run would race on the incremental cursor.
    expect(() => startScrapeRun(ctx.db)).toThrow(/already running/);
    await waitForRun();
  });

  it('allows a new run once the previous one is done', async () => {
    startScrapeRun(ctx.db);
    await waitForRun();
    expect(() => startScrapeRun(ctx.db)).not.toThrow();
    await waitForRun();
  });

  it('reports which source it is working on', async () => {
    feedDelayMs = 300;
    startScrapeRun(ctx.db);
    expect(getRunState()!.currentSourceId).toBeDefined();
    await waitForRun();
    expect(getRunState()!.currentSourceId).toBeUndefined();
    expect(getRunState()!.finishedAt).toBeTruthy();
  });
});

describe('recorded results (§4.4 last-run results)', () => {
  it('writes a row per source', async () => {
    startScrapeRun(ctx.db);
    await waitForRun();

    const runs = createScrapeRunRepository(ctx.db).listForSource('bbc');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ok: true, inserted: 2, itemsInFeed: 2, trigger: 'manual' });
  });

  it('records a failure with its reason, not just silence', async () => {
    feedStatus = 500;
    startScrapeRun(ctx.db);
    await waitForRun();

    const [run] = createScrapeRunRepository(ctx.db).listForSource('bbc');
    expect(run.ok).toBe(false);
    expect(run.error).toBeTruthy();
    expect(run.inserted).toBe(0);
  });

  it('keeps a failure visible after a later success', async () => {
    feedStatus = 500;
    startScrapeRun(ctx.db);
    await waitForRun();

    feedStatus = 200;
    startScrapeRun(ctx.db);
    await waitForRun();

    const runs = createScrapeRunRepository(ctx.db).listForSource('bbc');
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.ok)).toEqual([true, false]); // newest first
  });

  it('latestPerSource returns the newest run only', async () => {
    startScrapeRun(ctx.db);
    await waitForRun();
    startScrapeRun(ctx.db);
    await waitForRun();

    const latest = createScrapeRunRepository(ctx.db).latestPerSource();
    expect(Object.keys(latest)).toEqual(['bbc']);
    // The second run finds nothing new, per §5.2's incremental rule.
    expect(latest.bbc.inserted).toBe(0);
    expect(latest.bbc.skippedNotNew).toBe(2);
  });

  it('records the trigger', async () => {
    startScrapeRun(ctx.db, { trigger: 'scheduled' });
    await waitForRun();
    expect(createScrapeRunRepository(ctx.db).listForSource('bbc')[0].trigger).toBe('scheduled');
  });

  it('run history does not stop a source being deleted', async () => {
    startScrapeRun(ctx.db, { sourceId: 'cnn' });
    await waitForRun();
    // cnn has no articles, so only the run history could block deletion.
    expect(() => ctx.db.prepare(`DELETE FROM sources WHERE id = 'cnn'`).run()).not.toThrow();
    expect(createScrapeRunRepository(ctx.db).listForSource('cnn')).toHaveLength(0);
  });

  it('summarises totals for the UI', async () => {
    startScrapeRun(ctx.db);
    await waitForRun();
    expect(summarise(getRunState()!)).toMatchObject({ inserted: 2, failed: 0 });
  });
});

describe('HTTP routes (§4.4)', () => {
  it.each([
    ['GET', '/api/admin/scrape/status'],
    ['POST', '/api/admin/scrape'],
    ['POST', '/api/admin/scrape/bbc'],
  ])('%s %s needs admin auth', async (method, path) => {
    expect((await ctx.anon(path, { method })).status).toBe(401);
  });

  it('POST /scrape accepts and returns 202', async () => {
    const res = await ctx.api('/api/admin/scrape', { method: 'POST' });
    expect(res.status).toBe(202);
    expect((await res.json()).running).toBe(true);
    await waitForRun();
  });

  it('a second POST while running returns 409', async () => {
    feedDelayMs = 300; // keep the first run in flight
    await ctx.api('/api/admin/scrape', { method: 'POST' });
    const res = await ctx.api('/api/admin/scrape', { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already running/);
    await waitForRun();
  });

  it('status reports progress and then the finished totals', async () => {
    feedDelayMs = 300;
    await ctx.api('/api/admin/scrape', { method: 'POST' });
    expect((await (await ctx.api('/api/admin/scrape/status')).json()).running).toBe(true);

    await waitForRun();
    const done = await (await ctx.api('/api/admin/scrape/status')).json();
    expect(done.running).toBe(false);
    expect(done.run.summary.inserted).toBe(2);
    expect(done.lastRuns.bbc.inserted).toBe(2);
  });

  it('status works before anything has ever run', async () => {
    const body = await (await ctx.api('/api/admin/scrape/status')).json();
    expect(body).toMatchObject({ running: false, run: null, lastRuns: {} });
  });

  it('POST /scrape/:id 404s for an unknown source', async () => {
    expect((await ctx.api('/api/admin/scrape/ghost', { method: 'POST' })).status).toBe(404);
  });

  it('run history is available per source', async () => {
    await ctx.api('/api/admin/scrape', { method: 'POST' });
    await waitForRun();
    expect((await (await ctx.api('/api/admin/scrape/runs/bbc')).json())).toHaveLength(1);
  });
});
