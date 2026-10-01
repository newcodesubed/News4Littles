/**
 * The full text of a BBC article page — the one BBC-specific piece of ingestion.
 *
 * The RSS feed only carries a one-sentence description, too little for the
 * model to write a story from. The article page embeds the whole article as
 * JSON, so no HTML is parsed: the JSON is found, and the paragraph text read
 * out of it.
 *
 * Two page shapes are live, built on the same block model:
 *   - bbc.co.uk pages, and every Sport page:
 *       window.__INITIAL_DATA__ = "<JSON in a string>"
 *       -> data["article?…"].data.content.model.blocks
 *   - bbc.com news pages (Next.js):
 *       <script id="__NEXT_DATA__">
 *       -> props.pageProps.page[<key>].contents
 * Both are read, so a redirect from one edition to the other changes nothing.
 *
 * Only `text` and `subheadline` blocks are kept. Everything else on the page —
 * image captions, bylines, "related links", adverts, promos — lives in other
 * block types and is left out by construction.
 *
 * When BBC changes its markup, `npm run try:bbc -- <article url>` shows what
 * this still extracts.
 */

/** Same limit as a feed fetch: give up rather than hang the scheduler. */
const FETCH_TIMEOUT_MS = 15_000;

/** Says who we are, so BBC can tell this traffic apart and reach the owner. */
export const SCRAPER_USER_AGENT = 'News4LittlesBot/1.0';

const KEPT_BLOCK_TYPES = new Set(['text', 'subheadline']);

/**
 * True for a link to an article page: `/news/articles/<id>`,
 * `/sport/football/articles/<id>` and so on. Videos, audio, iPlayer and live
 * pages have no article text, so a feed item pointing at one is skipped.
 *
 * The host is deliberately not checked: feeds link to bbc.co.uk, the site also
 * answers on bbc.com, and tests serve article pages from 127.0.0.1.
 */
export function isBbcArticleUrl(link: string): boolean {
  try {
    return /\/articles\/[a-z0-9]+\/?$/.test(new URL(link).pathname);
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every paragraph's text under a node, in document order. */
function paragraphsIn(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) paragraphsIn(child, out);
    return;
  }
  if (!isRecord(node)) return;

  if (node.type === 'paragraph' && isRecord(node.model) && typeof node.model.text === 'string') {
    out.push(node.model.text);
    return;
  }
  for (const value of Object.values(node)) paragraphsIn(value, out);
}

/** The article's paragraphs from its top-level blocks, or null if it has none. */
function textOfBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;

  const paragraphs: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && typeof block.type === 'string' && KEPT_BLOCK_TYPES.has(block.type)) {
      paragraphsIn(block, paragraphs);
    }
  }

  const text = paragraphs.map((p) => p.trim()).filter(Boolean).join('\n\n');
  return text || null;
}

/** bbc.co.uk and Sport: a JSON document inside a JS string literal. */
function fromInitialData(html: string): string | null {
  const match = /window\.__INITIAL_DATA__\s*=\s*("(?:[^"\\]|\\.)*")/.exec(html);
  if (!match) return null;

  const data = (JSON.parse(JSON.parse(match[1]!) as string) as { data?: unknown }).data;
  if (!isRecord(data)) return null;

  for (const [key, entry] of Object.entries(data)) {
    if (!key.startsWith('article?') || !isRecord(entry)) continue;
    const content = isRecord(entry.data) ? entry.data.content : undefined;
    const model = isRecord(content) ? content.model : undefined;
    return textOfBlocks(isRecord(model) ? model.blocks : undefined);
  }
  return null;
}

/** bbc.com news: Next.js page props. */
function fromNextData(html: string): string | null {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;

  const props = (JSON.parse(match[1]!) as { props?: { pageProps?: { page?: unknown } } }).props;
  const page = props?.pageProps?.page;
  if (!isRecord(page)) return null;

  for (const article of Object.values(page)) {
    if (isRecord(article)) return textOfBlocks(article.contents);
  }
  return null;
}

/**
 * The article's paragraphs joined by blank lines, or null when the page holds
 * no article text: a video page, a changed layout, malformed JSON. Never throws
 * — a page is third-party data.
 */
export function extractBbcArticleText(html: string): string | null {
  for (const extract of [fromInitialData, fromNextData]) {
    try {
      const text = extract(html);
      if (text) return text;
    } catch {
      // Malformed JSON in one shape; the other may still be there.
    }
  }
  return null;
}

/** Worth one more try: the network, a server error, or being asked to slow down. */
const isTransient = (status: number) => status >= 500 || status === 429;

class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

async function fetchPage(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': SCRAPER_USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return response.text();
}

export interface FetchArticleOptions {
  timeoutMs?: number;
  /** Wait before the one retry. */
  retryDelayMs?: number;
}

/**
 * Fetch an article page and return its text. Throws on every failure —
 * network, HTTP status, or a page with no article text — so the caller has a
 * single path for "keep the feed's description instead".
 *
 * Retries once on a transient failure. A 404 or a page without text is not
 * retried: asking again gets the same answer.
 */
export async function fetchBbcArticleText(
  url: string,
  { timeoutMs = FETCH_TIMEOUT_MS, retryDelayMs = 1000 }: FetchArticleOptions = {},
): Promise<string> {
  let html: string;
  try {
    html = await fetchPage(url, timeoutMs);
  } catch (error: unknown) {
    if (error instanceof HttpError && !isTransient(error.status)) throw error;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    html = await fetchPage(url, timeoutMs);
  }

  const text = extractBbcArticleText(html);
  if (!text) throw new Error(`No article text found at ${url}`);
  return text;
}
