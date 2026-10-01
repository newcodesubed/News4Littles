/**
 * Full text from a BBC article page. Pages are served from a local HTTP server,
 * so these tests never touch the network.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  extractBbcArticleText, fetchBbcArticleText, isBbcArticleUrl, SCRAPER_USER_AGENT,
} from '../src/ingestion/bbcArticle.js';
import {
  ARTICLE_BLOCKS, ARTICLE_TEXT, block, initialDataPage, nextDataPage,
} from './bbcFixtures.js';

describe('extractBbcArticleText', () => {
  it('reads a bbc.co.uk / Sport page (__INITIAL_DATA__)', () => {
    expect(extractBbcArticleText(initialDataPage(ARTICLE_BLOCKS))).toBe(ARTICLE_TEXT);
  });

  it('reads a bbc.com page (__NEXT_DATA__)', () => {
    expect(extractBbcArticleText(nextDataPage(ARTICLE_BLOCKS))).toBe(ARTICLE_TEXT);
  });

  it('keeps body text and subheadings only: no headline, byline, caption or links', () => {
    const text = extractBbcArticleText(initialDataPage(ARTICLE_BLOCKS))!;
    for (const left of ['The adult headline', 'A Reporter', 'A photo caption', 'Related']) {
      expect(text).not.toContain(left);
    }
  });

  it('drops blank paragraphs and trims the rest', () => {
    const page = initialDataPage([block.text('  Padded.  ', '', '   ', 'Next.')]);
    expect(extractBbcArticleText(page)).toBe('Padded.\n\nNext.');
  });

  it('returns null for a page with no article text, like a video page', () => {
    expect(extractBbcArticleText(initialDataPage([block.headline('A video'), block.image('Still')])))
      .toBeNull();
  });

  it('returns null for a page with neither shape', () => {
    expect(extractBbcArticleText('<html><body><p>Just HTML.</p></body></html>')).toBeNull();
    expect(extractBbcArticleText('')).toBeNull();
  });

  it('returns null rather than throwing on malformed JSON', () => {
    expect(extractBbcArticleText('<script>window.__INITIAL_DATA__="{not json";</script>')).toBeNull();
    expect(extractBbcArticleText('<script id="__NEXT_DATA__" type="application/json">{oops</script>'))
      .toBeNull();
  });

  it('falls back to the other shape when one is malformed', () => {
    const page = `<script>window.__INITIAL_DATA__="{broken";</script>${nextDataPage(ARTICLE_BLOCKS)}`;
    expect(extractBbcArticleText(page)).toBe(ARTICLE_TEXT);
  });

  it('returns null when the JSON is valid but laid out differently', () => {
    expect(extractBbcArticleText(nextDataPage([]))).toBeNull();
    const elsewhere = `<script>window.__INITIAL_DATA__=${JSON.stringify(JSON.stringify({ data: { article: 1 } }))};</script>`;
    expect(extractBbcArticleText(elsewhere)).toBeNull();
  });
});

describe('isBbcArticleUrl', () => {
  it.each([
    'https://www.bbc.co.uk/news/articles/cv8e30enrkxyo',
    'https://www.bbc.com/news/articles/cv8e30enrkxyo',
    'https://www.bbc.co.uk/sport/football/articles/c6vgyg3zv3kwo',
    'https://www.bbc.co.uk/sport/articles/c6vgyg3zv3kwo',
    'https://www.bbc.co.uk/weather/articles/c6vgyg3zv3kwo',
    'http://127.0.0.1:4000/news/articles/abc123',
  ])('accepts %s', (url) => expect(isBbcArticleUrl(url)).toBe(true));

  it.each([
    'https://www.bbc.co.uk/news/videos/cq5ymyl1y29ko',
    'https://www.bbc.co.uk/sport/football/videos/cq5ymyl1y29ko',
    'https://www.bbc.co.uk/sounds/play/p0m3vwbk',
    'https://www.bbc.co.uk/iplayer/episode/m002k8qz',
    'https://www.bbc.co.uk/news/live/c4g7v71p1wxo',
    'https://www.bbc.co.uk/news/technology',
    'not a url',
    '',
  ])('rejects %s', (url) => expect(isBbcArticleUrl(url)).toBe(false));
});

describe('fetchBbcArticleText', () => {
  /** Responses to serve, in order, per path; the last one repeats. */
  let responses: Record<string, { status: number; html?: string }[]> = {};
  let requests: { path: string; userAgent: string | undefined }[] = [];
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '';
      const queue = responses[path] ?? [{ status: 404 }];
      const seen = requests.filter((r) => r.path === path).length;
      const response = queue[Math.min(seen, queue.length - 1)]!;
      requests.push({ path, userAgent: req.headers['user-agent'] });
      res.writeHead(response.status, { 'Content-Type': 'text/html' });
      res.end(response.html ?? '');
    });
    server.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  beforeEach(() => { responses = {}; requests = []; });

  const fetchText = (path: string) =>
    fetchBbcArticleText(`${origin}${path}`, { retryDelayMs: 0, timeoutMs: 2000 });

  it('returns the article text and says who is asking', async () => {
    responses['/news/articles/a1'] = [{ status: 200, html: initialDataPage(ARTICLE_BLOCKS) }];

    expect(await fetchText('/news/articles/a1')).toBe(ARTICLE_TEXT);
    expect(requests).toEqual([{ path: '/news/articles/a1', userAgent: SCRAPER_USER_AGENT }]);
  });

  it('throws on a 404 without asking again', async () => {
    await expect(fetchText('/news/articles/gone')).rejects.toThrow(/HTTP 404/);
    expect(requests).toHaveLength(1);
  });

  it('retries once after a server error', async () => {
    responses['/news/articles/a1'] = [
      { status: 503 },
      { status: 200, html: initialDataPage(ARTICLE_BLOCKS) },
    ];

    expect(await fetchText('/news/articles/a1')).toBe(ARTICLE_TEXT);
    expect(requests).toHaveLength(2);
  });

  it('retries once when asked to slow down (429), then gives up', async () => {
    responses['/news/articles/a1'] = [{ status: 429 }];

    await expect(fetchText('/news/articles/a1')).rejects.toThrow(/HTTP 429/);
    expect(requests).toHaveLength(2);
  });

  it('throws when the page has no article text', async () => {
    responses['/news/articles/video'] = [{ status: 200, html: '<html>Just a player</html>' }];

    await expect(fetchText('/news/articles/video')).rejects.toThrow(/No article text/);
    expect(requests).toHaveLength(1);
  });

  it('throws when nothing is listening', async () => {
    await expect(
      fetchBbcArticleText('http://127.0.0.1:1/news/articles/a1', { retryDelayMs: 0, timeoutMs: 2000 }),
    ).rejects.toThrow();
  });
});
