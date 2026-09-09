/**
 * RSS ingestion — PRD §5.2, in the order the spec lists:
 *   1-2. fetch and parse           -> feedParser.fetchFeed
 *   3.   skip items already seen   -> feedParser.selectNewItems
 *   4,6,7. store raw + kid rows    -> storeItems, below
 *   5.   advance the cursor        -> storeItems, below
 *
 * Written against the generic `sources` table rather than BBC specifically, so
 * enabling another feed in admin settings is all it takes to ingest it.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { createSourceRepository, type SourceRow } from '../db/repositories/sourceRepository.js';
import { simplifyArticle } from '../pipeline/simplifyArticle.js';
import { fetchFeed, selectNewItems, type FeedItem } from './feedParser.js';

export type { SourceRow };

/**
 * ASSUMPTION: the BBC front-page feed carries no category, and §5.2 does not
 * say what to put in RawArticle.topic. Everything lands in 'World', which is a
 * real category in the UI. The clean fix is per-source category feeds (BBC
 * publishes /news/science_and_environment/rss.xml and friends).
 */
const DEFAULT_TOPIC = 'World';

export interface ScrapeResult {
  sourceId: string;
  sourceName: string;
  ok: boolean;
  /** Set when the fetch or parse failed; the run is a no-op in that case. */
  error?: string;
  itemsInFeed: number;
  skippedNotNew: number;
  skippedAlreadyStored: number;
  skippedUnusable: number;
  inserted: number;
  newestItemPublishedAt: string | null;
  /** Headline, safety and engine for each stored article, for the CLI to print. */
  stored: { kidHeadline: string; safety: string; url: string; engine: string }[];
  /** Total USD spent on this run, so cost is visible rather than a surprise. */
  costUsd: number;
  /** One entry per article that had to fall back, with the reason (§9.1 step 4). */
  fallbacks: string[];
}

export interface ScrapeOptions {
  /** Cap items processed in one run; useful when testing. */
  limit?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => string;
}

function emptyResult(source: SourceRow): ScrapeResult {
  return {
    sourceId: source.id,
    sourceName: source.name,
    ok: false,
    itemsInFeed: 0,
    skippedNotNew: 0,
    skippedAlreadyStored: 0,
    skippedUnusable: 0,
    inserted: 0,
    newestItemPublishedAt: source.lastFetchedItemPublishedAt,
    stored: [],
    costUsd: 0,
    fallbacks: [],
  };
}

/**
 * Steps 4-7, in one transaction. A database failure rolls the whole run back,
 * so the cursor never advances past articles that were not stored.
 */
async function storeItems(
  db: Database,
  source: SourceRow,
  items: FeedItem[],
  fetchedAt: string,
  result: ScrapeResult,
): Promise<void> {
  const rawArticles = createRawArticleRepository(db);
  const articles = createArticleRepository(db);
  const sources = createSourceRepository(db);

  // Simplification is async (it may call a model), and better-sqlite3
  // transactions are synchronous — so every article is prepared first, then
  // the whole batch is written in one transaction.
  const prepared: { item: FeedItem; article: Awaited<ReturnType<typeof simplifyArticle>> }[] = [];

  for (const item of items) {
    if (rawArticles.existsForSourceUrl(source.id, item.link)) {
      result.skippedAlreadyStored += 1;
      continue;
    }
    prepared.push({
      item,
      article: await simplifyArticle(
        db,
        {
          id: 'pending',
          headline: item.title,
          body: item.body,
          topic: DEFAULT_TOPIC,
          sourceName: source.name,
          sourceUrl: item.link,
        },
        { now: fetchedAt },
      ),
    });
  }

  db.transaction(() => {
    let newest = source.lastFetchedItemPublishedAt;

    for (const { item, article: outcome } of prepared) {
      const rawId = randomUUID();
      rawArticles.insert({
        id: rawId,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        url: item.link,
        headline: item.title,
        body: item.body,
        topic: DEFAULT_TOPIC,
        publishedAt: item.publishedAt,
        fetchedAt,
        simplifiedAt: null,
      });

      // Step 7: never auto-publish, whatever the guard decided.
      articles.insert({
        ...outcome.article,
        originalId: rawId,
        status: 'pending_review',
        publishedAt: null,
      });

      result.inserted += 1;
      result.stored.push({
        kidHeadline: outcome.article.kidHeadline,
        safety: outcome.article.safety,
        url: item.link,
        engine: outcome.engine,
      });
      if (outcome.costUsd !== undefined) result.costUsd += outcome.costUsd;
      if (outcome.fallbackReason) result.fallbacks.push(outcome.fallbackReason);

      if (item.publishedAt && (!newest || item.publishedAt > newest)) newest = item.publishedAt;
    }

    // Step 5: advance the cursor to the newest item actually STORED, not the
    // newest merely seen, so a crash mid-run cannot skip items next time.
    sources.recordFetch(source.id, fetchedAt, newest);
    result.newestItemPublishedAt = newest;
  })();
}

/**
 * Ingest one source. Never throws: a dead feed, a timeout or malformed XML all
 * come back as `{ ok: false, error }`, so the scheduler and the API stay up.
 */
export async function scrapeSource(
  db: Database,
  source: SourceRow,
  options: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const result = emptyResult(source);

  if (!source.url) {
    result.error = `Source '${source.id}' has no feed URL configured.`;
    return result;
  }

  let items: Record<string, unknown>[];
  try {
    items = await fetchFeed(source.url);
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  result.itemsInFeed = items.length;

  const selection = selectNewItems(items, source.lastFetchedItemPublishedAt, options.limit);
  result.skippedNotNew = selection.skippedNotNew;
  result.skippedUnusable = selection.skippedUnusable;

  const fetchedAt = (options.now ?? (() => new Date().toISOString()))();

  try {
    await storeItems(db, source, selection.candidates, fetchedAt, result);
    result.ok = true;
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/** §5.2: "For each enabled source". */
export async function scrapeAllEnabledSources(
  db: Database,
  options: ScrapeOptions = {},
): Promise<ScrapeResult[]> {
  const sources = createSourceRepository(db).listEnabled();

  const results: ScrapeResult[] = [];
  for (const source of sources) {
    results.push(await scrapeSource(db, source, options));
  }
  return results;
}

export function getSource(db: Database, id: string): SourceRow | undefined {
  return createSourceRepository(db).findById(id);
}
