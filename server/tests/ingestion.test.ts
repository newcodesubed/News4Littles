/**
 * RSS ingestion — PRD §5.2, §5.3.
 * The feed is served from a local HTTP server, so these tests never touch the
 * network and cannot fail because the BBC changed its front page.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSource, scrapeSource, type SourceRow } from '../src/ingestion/rssScraper.js';
import { readScrapeTimes, timeToCron } from '../src/ingestion/scheduler.js';
import { countRows, createTestContext, type TestContext } from './helpers.js';

interface FeedItem { title?: string; link?: string; pubDate?: string; description?: string }

let feedItems: FeedItem[] = [];
let feedStatus = 200;
let feedBody: string | null = null;
let feedServer: Server;
let feedUrl: string;

function rss(items: FeedItem[]): string {
  const entries = items
    .map((i) => `<item>
      ${i.title ? `<title><![CDATA[${i.title}]]></title>` : ''}
      ${i.link ? `<link>${i.link}</link>` : ''}
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
  it('stores a raw article and a kid article per item', async () => {
    const result = await scrapeSource(ctx.db, bbc());
    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(2);
    expect(countRows(ctx.db, 'raw_articles')).toBe(2);
    expect(countRows(ctx.db, 'kid_articles')).toBe(2);
  });

  it('NEVER auto-publishes, whatever the guard says (§5.2 step 7)', async () => {
    await scrapeSource(ctx.db, bbc());
    const rows = ctx.db.prepare('SELECT status, publishedAt, safety FROM kid_articles').all() as any[];
    expect(rows.every((r) => r.status === 'pending_review')).toBe(true);
    expect(rows.every((r) => r.publishedAt === null)).toBe(true);
    // ...and the guard still ran.
    expect(rows.map((r) => r.safety)).toContain('adult-nearby');
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
    expect(result.stored[0].kidHeadline).toContain('brand new story');
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
