/**
 * RSS ingestion — PRD §5.2.
 *
 * Implements the seven steps in order:
 *   1. fetch the feed server-side
 *   2. parse items with rss-parser
 *   3. skip items with pubDate <= lastFetchedItemPublishedAt
 *   4. create RawArticle records
 *   5. update lastFetchedAt / lastFetchedItemPublishedAt to the newest item seen
 *   6. run the guard + simplification pipeline for the default age
 *   7. store as pending_review — never auto-publish
 *
 * Written against the generic `sources` table rather than BBC specifically, so
 * enabling another feed in admin settings is all it takes to ingest it. BBC is
 * simply the only enabled source today (§5.2 "First production source").
 */
import { randomUUID } from 'node:crypto';
import Parser from 'rss-parser';
import type { Database } from 'better-sqlite3';
import {
  loadLocalPipelineConfig,
  simplifyLocally,
  type RawArticleInput,
} from '../pipeline/localPipeline.js';

/** Give up on a feed rather than hanging the scheduler forever. */
const FEED_TIMEOUT_MS = 15_000;

/**
 * ASSUMPTION: the BBC front-page feed carries no category, and §5.2 does not
 * say what to put in RawArticle.topic. Everything lands in 'World', which is a
 * real category in the UI. The clean fix is per-source category feeds (BBC
 * publishes /news/science_and_environment/rss.xml and friends) or the LLM path,
 * which classifies from the text.
 */
const DEFAULT_TOPIC = 'World';

export interface SourceRow {
  id: string;
  name: string;
  url: string;
  enabled: number;
  lastFetchedItemPublishedAt: string | null;
}

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
  /** Headline + safety of each stored article, for the CLI to print. */
  stored: { kidHeadline: string; safety: string; url: string }[];
}

interface UsableItem {
  title: string;
  link: string;
  body: string;
  /** ISO string, or null when the feed gave no usable date. */
  publishedAt: string | null;
}

/**
 * Pull the fields ingestion needs out of a feed item, or return null if the
 * item cannot become an article.
 *
 * Feeds are third-party data and routinely contain half-filled entries, so
 * every field is checked rather than trusted.
 */
function toUsableItem(item: Record<string, unknown>): UsableItem | null {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const link = typeof item.link === 'string' ? item.link.trim() : '';
  if (!title || !link) return null;

  // contentSnippet is rss-parser's HTML-stripped summary; content may hold
  // markup. Falling back to the title keeps body NOT NULL satisfied.
  const snippet = typeof item.contentSnippet === 'string' ? item.contentSnippet.trim() : '';
  const content = typeof item.content === 'string' ? item.content.replace(/<[^>]*>/g, '').trim() : '';
  const body = snippet || content || title;

  // isoDate is rss-parser's normalised pubDate. Guard against unparseable
  // dates, which show up as Invalid Date rather than throwing.
  const rawDate =
    (typeof item.isoDate === 'string' && item.isoDate) ||
    (typeof item.pubDate === 'string' && item.pubDate) ||
    '';
  const parsed = rawDate ? new Date(rawDate) : null;
  const publishedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;

  return { title, link, body, publishedAt };
}

export interface ScrapeOptions {
  /** Cap items processed in one run; useful when testing. */
  limit?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => string;
}

/**
 * Ingest one source. Never throws: a dead feed, a timeout or malformed XML all
 * come back as `{ ok: false, error }` so the scheduler and the API stay up (§8
 * of the task brief).
 */
export async function scrapeSource(
  db: Database,
  source: SourceRow,
  options: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const now = options.now ?? (() => new Date().toISOString());

  const result: ScrapeResult = {
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
  };

  if (!source.url) {
    result.error = `Source '${source.id}' has no feed URL configured.`;
    return result;
  }

  // --- 1 & 2: fetch and parse, server-side ---------------------------------
  let items: Record<string, unknown>[];
  try {
    const feed = await new Parser({ timeout: FEED_TIMEOUT_MS }).parseURL(source.url);
    items = (feed.items ?? []) as Record<string, unknown>[];
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  result.itemsInFeed = items.length;
  const cutoff = source.lastFetchedItemPublishedAt;

  const candidates: UsableItem[] = [];
  for (const item of items) {
    const usable = toUsableItem(item);
    if (!usable) {
      result.skippedUnusable += 1;
      continue;
    }

    // --- 3: skip anything not newer than the last item we saw --------------
    // An item with no date cannot be compared, so it is let through and caught
    // by the already-stored check below instead.
    if (cutoff && usable.publishedAt && usable.publishedAt <= cutoff) {
      result.skippedNotNew += 1;
      continue;
    }

    candidates.push(usable);
  }

  const selected =
    options.limit === undefined ? candidates : candidates.slice(0, Math.max(0, options.limit));

  // --- 4, 6, 7: store raw + kid rows, inside one transaction ---------------
  const findExisting = db.prepare(
    `SELECT 1 FROM raw_articles WHERE sourceId = ? AND url = ? LIMIT 1`,
  );

  const insertRaw = db.prepare(
    `INSERT INTO raw_articles
       (id, sourceId, sourceName, sourceUrl, url, headline, body, topic, publishedAt, fetchedAt)
     VALUES (@id, @sourceId, @sourceName, @sourceUrl, @url, @headline, @body, @topic, @publishedAt, @fetchedAt)`,
  );

  const insertKid = db.prepare(
    `INSERT INTO kid_articles
       (id, originalId, ageTarget, kidHeadline, summary, whatHappened, whyItMatters, vocab,
        thinkAbout, feelingNote, safety, contentWarnings, category, readingMinutes,
        sourceName, sourceUrl, status, rejectReason, editedByHuman, createdAt, publishedAt)
     VALUES
       (@id, @originalId, @ageTarget, @kidHeadline, @summary, @whatHappened, @whyItMatters, @vocab,
        @thinkAbout, @feelingNote, @safety, @contentWarnings, @category, @readingMinutes,
        @sourceName, @sourceUrl, @status, @rejectReason, @editedByHuman, @createdAt, @publishedAt)`,
  );

  const updateSource = db.prepare(
    `UPDATE sources SET lastFetchedAt = @fetchedAt, lastFetchedItemPublishedAt = @newest, updatedAt = @fetchedAt
     WHERE id = @id`,
  );

  const config = loadLocalPipelineConfig(db);
  const fetchedAt = now();

  const runTransaction = db.transaction(() => {
    let newest = source.lastFetchedItemPublishedAt;

    for (const item of selected) {
      // ASSUMPTION (not in §5.2): skip an item whose URL is already stored for
      // this source. Needed because undated items cannot be date-filtered, and
      // because a re-published story returns with a fresh pubDate. The schema
      // deliberately has no UNIQUE(url) so this is a skip, not a crash.
      if (findExisting.get(source.id, item.link)) {
        result.skippedAlreadyStored += 1;
        continue;
      }

      const rawId = randomUUID();
      insertRaw.run({
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
      });

      // --- 6: guard then simplify, at the default age -----------------------
      const rawInput: RawArticleInput = {
        id: rawId,
        headline: item.title,
        body: item.body,
        topic: DEFAULT_TOPIC,
        sourceName: source.name,
        sourceUrl: item.link,
      };
      const { article } = simplifyLocally(rawInput, config, { now: fetchedAt });

      insertKid.run({
        ...article,
        vocab: JSON.stringify(article.vocab),
        contentWarnings: article.contentWarnings ? JSON.stringify(article.contentWarnings) : null,
        editedByHuman: article.editedByHuman ? 1 : 0,
        // --- 7: never auto-publish, whatever the guard decided --------------
        status: 'pending_review',
        publishedAt: null,
      });

      result.inserted += 1;
      result.stored.push({
        kidHeadline: article.kidHeadline,
        safety: article.safety,
        url: item.link,
      });

      if (item.publishedAt && (!newest || item.publishedAt > newest)) {
        newest = item.publishedAt;
      }
    }

    // --- 5: advance the incremental cursor --------------------------------
    // Uses the newest item actually STORED, not the newest merely seen, so a
    // crash mid-run cannot skip items on the next pass.
    updateSource.run({ id: source.id, fetchedAt, newest });
    result.newestItemPublishedAt = newest;
  });

  try {
    runTransaction();
    result.ok = true;
  } catch (error: unknown) {
    // A database failure rolls the whole run back; the cursor does not move.
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/** §5.2: "For each enabled source". */
export async function scrapeAllEnabledSources(
  db: Database,
  options: ScrapeOptions = {},
): Promise<ScrapeResult[]> {
  const sources = db
    .prepare(
      `SELECT id, name, url, enabled, lastFetchedItemPublishedAt
       FROM sources WHERE enabled = 1 AND url <> '' ORDER BY id`,
    )
    .all() as SourceRow[];

  const results: ScrapeResult[] = [];
  for (const source of sources) {
    results.push(await scrapeSource(db, source, options));
  }
  return results;
}

export function getSource(db: Database, id: string): SourceRow | undefined {
  return db
    .prepare(
      `SELECT id, name, url, enabled, lastFetchedItemPublishedAt FROM sources WHERE id = ?`,
    )
    .get(id) as SourceRow | undefined;
}
