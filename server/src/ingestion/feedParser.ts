/**
 * Turning a feed URL into items this app can store — PRD §5.2 steps 1-2.
 *
 * Feeds are third-party data and routinely contain half-filled entries, so
 * every field is checked rather than trusted.
 */
import Parser from 'rss-parser';

/** Give up on a feed rather than hanging the scheduler forever. */
const FEED_TIMEOUT_MS = 15_000;

/**
 * Query parameters publishers add for their own analytics — BBC's feed links
 * all carry `at_medium=RSS&at_campaign=rss`. They never change which page you
 * get, and the duplicate guard in rawArticleRepository.existsForSourceUrl is an
 * exact string match on the URL, so the same story arriving with new campaign
 * tags would look like a new article and cost another simplification.
 *
 * Deliberately an allowlist of known tracking keys rather than "drop the query
 * string": plenty of publishers put the article id or page number in there
 * (`?id=1234`, `?page=2`), and dropping those breaks the link outright.
 * `ref` is left in place for the same reason — it is load-bearing on some sites.
 */
const TRACKING_PREFIXES = ['at_', 'utm_'];
const TRACKING_KEYS = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'twclid',
  'igshid', 'mc_cid', 'mc_eid',
]);

const isTracking = (key: string): boolean => {
  const name = key.toLowerCase();
  return TRACKING_KEYS.has(name) || TRACKING_PREFIXES.some((prefix) => name.startsWith(prefix));
};

/**
 * The article's URL with tracking parameters removed. Anything that is not a
 * parseable absolute URL, or that carries no tracking, comes back byte for byte
 * unchanged — most links have none, and re-serialising them through URL() would
 * churn them for no reason.
 */
export function canonicalUrl(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link;
  }

  const tracking = [...url.searchParams.keys()].filter(isTracking);
  if (tracking.length === 0) return link;

  for (const key of tracking) url.searchParams.delete(key);
  return url.toString();
}

export interface FeedItem {
  title: string;
  link: string;
  body: string;
  /** ISO string, or null when the feed gave no usable date. */
  publishedAt: string | null;
}

/** Fetch and parse, server-side (§5.2 step 1). Throws on network or XML failure. */
export async function fetchFeed(url: string): Promise<Record<string, unknown>[]> {
  const feed = await new Parser({ timeout: FEED_TIMEOUT_MS }).parseURL(url);
  return (feed.items ?? []) as Record<string, unknown>[];
}

/** Extract the fields ingestion needs, or null if the item cannot become an article. */
export function toFeedItem(item: Record<string, unknown>): FeedItem | null {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const link = typeof item.link === 'string' ? item.link.trim() : '';
  if (!title || !link) return null;

  // Canonicalised here rather than at storage time, so the duplicate guard and
  // the stored URL both see the same string.
  return {
    title,
    link: canonicalUrl(link),
    body: readBody(item, title),
    publishedAt: readPublishedAt(item),
  };
}

/**
 * contentSnippet is rss-parser's HTML-stripped summary; content may hold
 * markup. Falling back to the title keeps the NOT NULL body satisfied.
 */
function readBody(item: Record<string, unknown>, title: string): string {
  const snippet = typeof item.contentSnippet === 'string' ? item.contentSnippet.trim() : '';
  const content =
    typeof item.content === 'string' ? item.content.replace(/<[^>]*>/g, '').trim() : '';
  return snippet || content || title;
}

/**
 * isoDate is rss-parser's normalised pubDate. Guards against unparseable
 * dates, which surface as Invalid Date rather than throwing.
 */
function readPublishedAt(item: Record<string, unknown>): string | null {
  const raw =
    (typeof item.isoDate === 'string' && item.isoDate) ||
    (typeof item.pubDate === 'string' && item.pubDate) ||
    '';
  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export interface SelectionResult {
  candidates: FeedItem[];
  skippedNotNew: number;
  skippedUnusable: number;
}

/**
 * §5.2 step 3: skip anything not newer than the last item seen.
 *
 * An item with no date cannot be compared, so it passes through here and is
 * caught by the already-stored check at persist time instead.
 */
export function selectNewItems(
  items: Record<string, unknown>[],
  cursor: string | null,
  limit?: number,
): SelectionResult {
  const result: SelectionResult = { candidates: [], skippedNotNew: 0, skippedUnusable: 0 };

  for (const raw of items) {
    const item = toFeedItem(raw);
    if (!item) {
      result.skippedUnusable += 1;
      continue;
    }
    if (cursor && item.publishedAt && item.publishedAt <= cursor) {
      result.skippedNotNew += 1;
      continue;
    }
    result.candidates.push(item);
  }

  if (limit !== undefined) result.candidates = result.candidates.slice(0, Math.max(0, limit));
  return result;
}
