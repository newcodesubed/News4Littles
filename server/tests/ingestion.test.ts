/**
 * RSS ingestion — PRD §5.2, §5.3.
 * The feed is served from a local HTTP server, so these tests never touch the
 * network and cannot fail because the BBC changed its front page.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSource, scrapeSource, type SourceRow } from '../src/ingestion/rssScraper.js';
import { canonicalUrl } from '../src/ingestion/feedParser.js';
import { readScrapeTimes, timeToCron } from '../src/ingestion/scheduler.js';
import {
  resetRunState, startScrapeRun, summarise, type RunState,
} from '../src/services/scrapeService.js';
import { countRows, createTestContext, type TestContext } from './helpers.js';

interface FeedItem { title?: string; link?: string; pubDate?: string; description?: string }

let feedItems: FeedItem[] = [];
let feedStatus = 200;
let feedBody: string | null = null;
let feedServer: Server;
let feedUrl: string;

/**
 * Escape a value for XML text. Titles and descriptions below sit in CDATA, but
 * <link> does not — and a raw '&' in a query string makes the parse throw
 * "Invalid character in entity name". Real feeds escape it, so the fixture must.
 */
const xml = (value: string) => value.replace(/&/g, '&amp;');

function rss(items: FeedItem[]): string {
  const entries = items
    .map((i) => `<item>
      ${i.title ? `<title><![CDATA[${i.title}]]></title>` : ''}
      ${i.link ? `<link>${xml(i.link)}</link>` : ''}
      ${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}
      ${i.description ? `<description><![CDATA[${i.description}]]></description>` : ''}
    </item>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>Test Feed</title><link>https://example.com</link><description>Test</description>
    ${entries}</channel></rss>`;
}

beforeAll(async () => {
  feedServer = createServer((_req, res) => {
    if (feedStatus !== 200) { res.writeHead(feedStatus); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(feedBody ?? rss(feedItems));
  });
  feedServer.listen(0);
  await new Promise((r) => feedServer.once('listening', r));
  feedUrl = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/rss.xml`;
});
afterAll(() => feedServer.close());

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
  feedStatus = 200;
  feedBody = null;
  feedItems = [
    { title: 'A rover surveyed the reef', link: 'https://example.com/1', pubDate: 'Thu, 03 Sep 2026 10:00:00 GMT', description: 'A calm story about the sea.' },
    { title: 'Storm brings a disaster and an earthquake', link: 'https://example.com/2', pubDate: 'Fri, 04 Sep 2026 10:00:00 GMT', description: 'A disaster and an earthquake struck.' },
  ];
  ctx.db.prepare(`UPDATE sources SET url = ? WHERE id = 'bbc'`).run(feedUrl);
});
afterEach(() => ctx.close());

const bbc = () => getSource(ctx.db, 'bbc') as SourceRow;

describe('happy path (§5.2)', () => {
  it('stores a raw article per item and simplifies none of them', async () => {
    // §5.2 steps 1-5 only. Steps 6-7 moved to simplifyService, under a budget:
    // a full feed is 40-50 model calls for a queue an editor triages ten of.
    const result = await scrapeSource(ctx.db, bbc());

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(2);
    expect(countRows(ctx.db, 'raw_articles')).toBe(2);
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
    expect(result.simplified).toEqual([]);
  });

  it('leaves every stored article waiting', async () => {
    await scrapeSource(ctx.db, bbc());

    const waiting = ctx.db
      .prepare(`SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL`)
      .pluck().get();
    expect(waiting).toBe(2);
  });

  it('reports what it stored, by raw id rather than kid headline', async () => {
    const result = await scrapeSource(ctx.db, bbc());

    expect(result.stored).toHaveLength(2);
    expect(result.stored[0]).toMatchObject({ url: 'https://example.com/1' });
    expect(result.stored[0].rawId).toEqual(expect.any(String));
    expect(result.stored[0].headline).toBe('A rover surveyed the reef');
  });

  it('advances the cursor to the newest stored item (§5.2 step 5)', async () => {
    const result = await scrapeSource(ctx.db, bbc());
    expect(result.newestItemPublishedAt).toBe('2026-09-04T10:00:00.000Z');
    expect(bbc().lastFetchedItemPublishedAt).toBe('2026-09-04T10:00:00.000Z');
  });
});

describe('incremental fetching (§5.2 step 3)', () => {
  it('a second run with no new items inserts nothing', async () => {
    await scrapeSource(ctx.db, bbc());
    const second = await scrapeSource(ctx.db, bbc());
    expect(second.inserted).toBe(0);
    expect(second.skippedNotNew).toBe(2);
  });

  it('picks up only genuinely newer items', async () => {
    await scrapeSource(ctx.db, bbc());
    feedItems.push({ title: 'A brand new story', link: 'https://example.com/3', pubDate: 'Sat, 05 Sep 2026 10:00:00 GMT', description: 'Fresh.' });

    const result = await scrapeSource(ctx.db, bbc());
    expect(result.inserted).toBe(1);
    expect(result.stored[0].headline).toContain('brand new story');
  });

  it('skips an item whose URL is already stored, even if re-dated', async () => {
    await scrapeSource(ctx.db, bbc());
    ctx.db.prepare(`UPDATE sources SET lastFetchedItemPublishedAt = NULL WHERE id = 'bbc'`).run();

    const result = await scrapeSource(ctx.db, bbc());
    expect(result.inserted).toBe(0);
    expect(result.skippedAlreadyStored).toBe(2);
  });
});

describe('malformed feed data', () => {
  it('skips items with no title or link', async () => {
    feedItems = [
      { title: 'Fine', link: 'https://example.com/ok', pubDate: 'Thu, 03 Sep 2026 10:00:00 GMT' },
      { title: 'No link at all' },
      { link: 'https://example.com/no-title' },
    ];
    const result = await scrapeSource(ctx.db, bbc());
    expect(result.inserted).toBe(1);
    expect(result.skippedUnusable).toBe(2);
  });

  it('accepts an item with no date rather than dropping it', async () => {
    feedItems = [{ title: 'Undated story', link: 'https://example.com/undated', description: 'No pubDate.' }];
    const result = await scrapeSource(ctx.db, bbc());
    expect(result.inserted).toBe(1);
  });

  it('survives an unparseable date', async () => {
    feedItems = [{ title: 'Bad date', link: 'https://example.com/bad', pubDate: 'not a date' }];
    expect((await scrapeSource(ctx.db, bbc())).ok).toBe(true);
  });

  it('falls back to the title when there is no description', async () => {
    feedItems = [{ title: 'Only a title here', link: 'https://example.com/t', pubDate: 'Thu, 03 Sep 2026 10:00:00 GMT' }];
    await scrapeSource(ctx.db, bbc());
    const raw = ctx.db.prepare('SELECT body FROM raw_articles').get() as any;
    expect(raw.body).toBe('Only a title here');
  });
});

describe('failure handling', () => {
  it('returns ok:false for an unreachable host, without throwing', async () => {
    const source = { ...bbc(), url: 'http://127.0.0.1:1/rss.xml' };
    const result = await scrapeSource(ctx.db, source);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns ok:false for a 404', async () => {
    feedStatus = 404;
    expect((await scrapeSource(ctx.db, bbc())).ok).toBe(false);
  });

  it('returns ok:false for HTML served instead of RSS', async () => {
    feedBody = '<!doctype html><html><body>Not a feed &nbsp; at all</body></html>';
    expect((await scrapeSource(ctx.db, bbc())).ok).toBe(false);
  });

  it('returns ok:false when the source has no URL', async () => {
    const result = await scrapeSource(ctx.db, { ...bbc(), url: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no feed URL/);
  });

  it('a failed run writes nothing and does not move the cursor', async () => {
    await scrapeSource(ctx.db, bbc());
    const cursor = bbc().lastFetchedItemPublishedAt;
    const counts = [countRows(ctx.db, 'raw_articles'), countRows(ctx.db, 'kid_articles')];

    feedStatus = 500;
    await scrapeSource(ctx.db, bbc());

    expect(bbc().lastFetchedItemPublishedAt).toBe(cursor);
    expect([countRows(ctx.db, 'raw_articles'), countRows(ctx.db, 'kid_articles')]).toEqual(counts);
  });
});

describe('limit option', () => {
  it('caps how many items one run stores', async () => {
    // Distinct from the simplification budget: limit DISCARDS the rest,
    // the budget only defers them.
    const result = await scrapeSource(ctx.db, bbc(), { limit: 1 });
    expect(result.inserted).toBe(1);
  });
});

describe('schedule parsing (§5.3)', () => {
  it.each([
    ['06:00', '0 6 * * *'],
    ['6:30', '30 6 * * *'],
    ['23:59', '59 23 * * *'],
    ['00:00', '0 0 * * *'],
  ])('%s -> %s', (time, expression) => expect(timeToCron(time)).toBe(expression));

  it.each(['25:00', '06:60', 'morning', '', '6'])('rejects %s', (time) => {
    expect(() => timeToCron(time)).toThrow();
  });

  it('reads the configured times from app_settings', () => {
    expect(readScrapeTimes(ctx.db)).toEqual(['06:00']);
  });

  it('cannot be corrupted: the schema rejects non-JSON in the column', () => {
    // The json_valid CHECK means readScrapeTimes' parse guard is belt-and-braces.
    expect(() =>
      ctx.db.prepare(`UPDATE app_settings SET scrapeTimes = '["06:00"' WHERE id='default'`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('returns an empty list when the settings row is missing', () => {
    ctx.db.prepare(`DELETE FROM app_settings`).run();
    expect(readScrapeTimes(ctx.db)).toEqual([]);
  });
});

describe('the simplification budget', () => {
  /** Runs a full scrape and resolves when the background run has finished. */
  const runToCompletion = (budget?: number) =>
    new Promise<RunState>((resolve) => {
      startScrapeRun(ctx.db, { budget, onFinished: resolve });
    });

  const waitingCount = () =>
    ctx.db.prepare(`SELECT COUNT(*) FROM raw_articles WHERE simplifiedAt IS NULL`).pluck().get();

  beforeEach(() => {
    resetRunState();
    // 25 items, oldest first, so the newest-first rule is actually exercised.
    feedItems = Array.from({ length: 25 }, (_, i) => ({
      title: `Story number ${i + 1}`,
      link: `https://example.com/story-${i + 1}`,
      pubDate: new Date(Date.UTC(2026, 8, 1, i)).toUTCString(),
      description: 'A calm story about the sea and the coral that lives in it.',
    }));
  });
  afterEach(() => resetRunState());

  it('stores everything but simplifies only the budget', async () => {
    const state = await runToCompletion(10);

    expect(countRows(ctx.db, 'raw_articles')).toBe(25);
    // Ten stories, ten reading ages each.
    expect(countRows(ctx.db, 'kid_articles')).toBe(100);
    expect(waitingCount()).toBe(15);
    expect(summarise(state).simplified).toBe(10);
  });

  it('advances the cursor past every stored item, not just the simplified ones', async () => {
    // Otherwise the 15 left raw would be re-fetched and re-stored next run.
    await runToCompletion(10);

    expect(bbc().lastFetchedItemPublishedAt).toBe(new Date(Date.UTC(2026, 8, 1, 24)).toISOString());
  });

  it('simplifies the newest stories first', async () => {
    await runToCompletion(3);

    const headlines = ctx.db
      .prepare(`SELECT r.headline FROM raw_articles r WHERE r.simplifiedAt IS NOT NULL`)
      .pluck().all();
    expect(headlines).toHaveLength(3);
    expect(headlines).toEqual(
      expect.arrayContaining(['Story number 25', 'Story number 24', 'Story number 23']),
    );
  });

  it('a second run works through the backlog rather than re-fetching', async () => {
    await runToCompletion(10);
    const state = await runToCompletion(10);

    // Nothing new in the feed, so phase 1 inserts nothing and phase 2 spends
    // the budget on what was left waiting.
    expect(summarise(state).inserted).toBe(0);
    expect(countRows(ctx.db, 'kid_articles')).toBe(200);
    expect(waitingCount()).toBe(5);
  });

  it('a budget of 0 simplifies nothing and still stores everything', async () => {
    await runToCompletion(0);

    expect(countRows(ctx.db, 'raw_articles')).toBe(25);
    expect(countRows(ctx.db, 'kid_articles')).toBe(0);
  });

  it('reads the budget from app_settings when none is passed', async () => {
    ctx.db.prepare(`UPDATE app_settings SET simplifyBudget = 2 WHERE id = 'default'`).run();

    await runToCompletion();

    expect(countRows(ctx.db, 'kid_articles')).toBe(20);
  });

  it('still never auto-publishes what it simplifies (§5.2 step 7)', async () => {
    await runToCompletion(5);

    expect(ctx.db.prepare(`SELECT DISTINCT status FROM kid_articles`).pluck().all())
      .toEqual(['pending_review']);
  });
});

describe('canonicalUrl', () => {
  it("strips the campaign tags BBC puts on its feed links", () => {
    expect(
      canonicalUrl('https://www.bbc.co.uk/news/articles/cp9340rg7k8o?at_medium=RSS&at_campaign=rss'),
    ).toBe('https://www.bbc.co.uk/news/articles/cp9340rg7k8o');
  });

  it('strips utm_* and the common click ids', () => {
    expect(canonicalUrl('https://e.com/a?utm_source=x&utm_medium=y&utm_campaign=z')).toBe('https://e.com/a');
    expect(canonicalUrl('https://e.com/a?fbclid=abc')).toBe('https://e.com/a');
    expect(canonicalUrl('https://e.com/a?gclid=abc')).toBe('https://e.com/a');
  });

  it('keeps parameters that decide which page you get', () => {
    // Stripping the query string wholesale would break these.
    expect(canonicalUrl('https://e.com/story?id=1234')).toBe('https://e.com/story?id=1234');
    expect(canonicalUrl('https://e.com/list?page=2')).toBe('https://e.com/list?page=2');
  });

  it('keeps the real parameters and drops only the tracking ones', () => {
    expect(canonicalUrl('https://e.com/story?id=99&utm_source=rss&page=3')).toBe(
      'https://e.com/story?id=99&page=3',
    );
  });

  it('leaves the fragment alone', () => {
    expect(canonicalUrl('https://e.com/a?at_medium=RSS#section-2')).toBe('https://e.com/a#section-2');
  });

  it('returns the original string untouched when there is nothing to strip', () => {
    // Not re-serialised through URL(), so no normalisation churn on the
    // overwhelming majority of links that carry no tracking at all.
    const plain = 'https://e.com/a/b';
    expect(canonicalUrl(plain)).toBe(plain);
  });

  it('survives something that is not a URL at all', () => {
    expect(canonicalUrl('not a url')).toBe('not a url');
    expect(canonicalUrl('')).toBe('');
  });
});

describe('tracking parameters in ingestion', () => {
  it('stores the canonical link, so the original opens the article cleanly', async () => {
    feedItems = [{
      title: 'A tagged story',
      link: 'https://www.bbc.co.uk/news/articles/abc123?at_medium=RSS&at_campaign=rss',
      pubDate: 'Fri, 04 Sep 2026 10:00:00 GMT',
      description: 'A calm story about the sea.',
    }];

    await scrapeSource(ctx.db, bbc());

    expect(ctx.db.prepare(`SELECT url FROM raw_articles`).pluck().get())
      .toBe('https://www.bbc.co.uk/news/articles/abc123');
  });

  it('treats the same story with new campaign tags as already stored', async () => {
    // This is the reason to strip them: the duplicate guard is an exact string
    // match on the URL, so a re-tagged link would otherwise look like a new
    // article and cost another simplification.
    feedItems = [{
      title: 'A tagged story',
      link: 'https://www.bbc.co.uk/news/articles/abc123?at_medium=RSS&at_campaign=rss',
      pubDate: 'Fri, 04 Sep 2026 10:00:00 GMT',
      description: 'A calm story about the sea.',
    }];
    await scrapeSource(ctx.db, bbc());

    // Same article, same date, different campaign tags.
    feedItems = [{
      title: 'A tagged story',
      link: 'https://www.bbc.co.uk/news/articles/abc123?at_medium=custom7&at_campaign=64',
      pubDate: 'Sat, 05 Sep 2026 10:00:00 GMT',
      description: 'A calm story about the sea.',
    }];
    const second = await scrapeSource(ctx.db, bbc());

    expect(second.inserted).toBe(0);
    expect(second.skippedAlreadyStored).toBe(1);
    expect(countRows(ctx.db, 'raw_articles')).toBe(1);
  });
});
