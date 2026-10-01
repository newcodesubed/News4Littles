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
 *
 * FULL TEXT: a feed's description is one sentence, too little to write a story
 * from. A source with parser 'bbc' also fetches each new item's article page
 * (ingestion/bbcArticle.ts) between selecting and storing. If that fails the
 * description is stored instead, so an item is never worse off than plain RSS.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { createSourceRepository, type SourceRow } from '../db/repositories/sourceRepository.js';
import { logger } from '../logger.js';
import { guessCategory } from '../pipeline/categorize.js';
import { fetchBbcArticleText, isBbcArticleUrl } from './bbcArticle.js';
import { fetchFeed, selectNewItems, type FeedItem } from './feedParser.js';

const log = logger.child({ area: 'scrape' });

/** Pause between article pages: one source's run is a few dozen requests. */
const ARTICLE_DELAY_MS = 1000;

/**
 * Consecutive article fetches that may fail before a source stops trying for
 * this run. Several failures in a row means blocked or down, not one bad page,
 * and carrying on would only add a timeout per item.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export type { SourceRow };

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
  /** Items stored with the feed's description because their page gave no text. */
  fullTextFailed: number;
  newestItemPublishedAt: string | null;
  /** What was stored, for the CLI to print. Raw rows: no kid headline yet. */
  stored: { rawId: string; headline: string; url: string; publishedAt: string | null }[];
  /** Filled by the run's simplification phase, not by this module. */
  simplified: { rawId: string; kidHeadline: string; safety: string }[];
  /** Age versions written for this source's stories, filled by phase 2. */
  versionsCreated: number;
  /** This source's raws still waiting after the run, filled by phase 2. */
  leftWaiting: number;
  /** Total USD spent on this run, so cost is visible rather than a surprise. */
  costUsd: number;
  /** One entry per story the model could not write, so its article was deleted. */
  dropped: string[];
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
  /** Pause between article page fetches. A test seam; defaults to 1s. */
  articleDelayMs?: number;
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
    fullTextFailed: 0,
    newestItemPublishedAt: source.lastFetchedItemPublishedAt,
    stored: [],
    simplified: [],
    versionsCreated: 0,
    leftWaiting: 0,
    costUsd: 0,
    dropped: [],
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
      if (rawArticles.existsByUrl(item.link)) {
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
        // A section feed knows its subject; a mixed feed, like the BBC front
        // page, does not, so the topic is guessed from keywords. Either way it
        // is a hint: the LLM picks its own when it runs (pipeline/categorize.ts).
        topic: source.category ?? guessCategory(item.title, item.body),
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
 * Replace each candidate's one-line description with its article's full text.
 *
 * Sequential with a pause between pages, to be a polite visitor. Skips URLs
 * already stored — storeItems would discard them anyway. A failure keeps the
 * description; MAX_CONSECUTIVE_FAILURES in a row stops fetching for the rest
 * of this source's run.
 */
async function addFullText(
  db: Database,
  source: SourceRow,
  items: FeedItem[],
  result: ScrapeResult,
  delayMs: number,
): Promise<void> {
  const rawArticles = createRawArticleRepository(db);
  let consecutiveFailures = 0;
  let fetched = 0;

  for (const item of items) {
    if (rawArticles.existsByUrl(item.link)) continue;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      result.fullTextFailed += 1;
      continue;
    }

    if (fetched > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    fetched += 1;

    try {
      item.body = await fetchBbcArticleText(item.link, { retryDelayMs: delayMs });
      consecutiveFailures = 0;
    } catch (error: unknown) {
      consecutiveFailures += 1;
      result.fullTextFailed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      log.warn({ sourceId: source.id, url: item.link, reason }, 'kept the feed description');
      if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
        log.warn({ sourceId: source.id }, 'stopped fetching article pages for this run');
      }
    }
  }
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

  const fullText = source.parser === 'bbc';

  // A BBC video, audio or live link has no article text to fetch, and a
  // one-line description is not enough to write a story from.
  const selection = selectNewItems(
    items,
    source.lastFetchedItemPublishedAt,
    options.limit,
    fullText ? (item) => isBbcArticleUrl(item.link) : undefined,
  );
  result.skippedNotNew = selection.skippedNotNew;
  result.skippedUnusable = selection.skippedUnusable;

  try {
    if (fullText) {
      const delayMs = options.articleDelayMs ?? ARTICLE_DELAY_MS;
      await addFullText(db, source, selection.candidates, result, delayMs);
    }

    // After the pages: a run's stories are stamped when they were stored.
    const fetchedAt = (options.now ?? (() => new Date().toISOString()))();
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
