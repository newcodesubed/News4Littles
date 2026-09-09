/**
 * RSS ingestion — PRD §5.2, in the order the spec lists:
 *   1-2. fetch and parse           -> feedParser.fetchFeed
 *   3.   skip items already seen   -> feedParser.selectNewItems
 *   4.   store raw rows            -> storeItems, below
 *   5.   advance the cursor        -> storeItems, below
 *
 * DIVERGENCE FROM §5.2: the spec's steps 6-7 (guard + simplify + store as
 * pending_review) used to run here, once per item. That made one run 40-50 LLM
 * calls for a queue an editor triages ten of, so they now live in
 * services/simplifyService.ts and run for a budgeted subset only
 * (app_settings.simplifyBudget). Everything is still STORED here; only the
 * spending moved.
 *
 * Written against the generic `sources` table rather than BBC specifically, so
 * enabling another feed in admin settings is all it takes to ingest it.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { createSourceRepository, type SourceRow } from '../db/repositories/sourceRepository.js';
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
  /** What was stored, for the CLI to print. Raw rows: no kid headline yet. */
  stored: { rawId: string; headline: string; url: string; publishedAt: string | null }[];
  /** Filled by the run's simplification phase, not by this module. */
  simplified: { rawId: string; kidHeadline: string; safety: string; engine: string }[];
  /** Age versions written for this source's stories, filled by phase 2. */
  versionsCreated: number;
  /** This source's raws still waiting after the run, filled by phase 2. */
  leftWaiting: number;
  /** Total USD spent on this run, so cost is visible rather than a surprise. */
  costUsd: number;
  /** One entry per article that had to fall back, with the reason (§9.1 step 4). */
  fallbacks: string[];
}

export interface ScrapeOptions {
  /**
   * Cap items FETCHED AND STORED in one run, discarding the rest; useful when
   * testing. Not to be confused with app_settings.simplifyBudget, which caps
   * how many STORED items get simplified. This one loses articles; that one
   * only defers them.
   */
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
    simplified: [],
    versionsCreated: 0,
    leftWaiting: 0,
    costUsd: 0,
    fallbacks: [],
  };
}

/**
 * Steps 4-5, in one transaction. A database failure rolls the whole run back,
 * so the cursor never advances past articles that were not stored.
 *
 * Synchronous now: with simplification moved out there is nothing async left,
 * so the two-pass "prepare then write" dance this used to need is gone.
 */
function storeItems(
  db: Database,
  source: SourceRow,
  items: FeedItem[],
  fetchedAt: string,
  result: ScrapeResult,
): void {
  const rawArticles = createRawArticleRepository(db);
  const sources = createSourceRepository(db);

  db.transaction(() => {
    let newest = source.lastFetchedItemPublishedAt;

    for (const item of items) {
      if (rawArticles.existsForSourceUrl(source.id, item.link)) {
        result.skippedAlreadyStored += 1;
        continue;
      }

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
        // The run's simplification phase decides which of these get a model
        // call; the rest wait in the review queue's "not yet simplified" tab.
        simplifiedAt: null,
      });

      result.inserted += 1;
      result.stored.push({
        rawId,
        headline: item.title,
        url: item.link,
        publishedAt: item.publishedAt,
      });

      if (item.publishedAt && (!newest || item.publishedAt > newest)) newest = item.publishedAt;
    }

    // Step 5: advance the cursor to the newest item actually STORED, not the
    // newest merely seen, so a crash mid-run cannot skip items next time.
    // Storing is now unconditional, so nothing is dropped for being unsimplified.
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
    storeItems(db, source, selection.candidates, fetchedAt, result);
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
