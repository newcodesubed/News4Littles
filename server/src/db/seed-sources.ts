/**
 * The seeded news sources — PRD §5.1 — in one place, because two steps write
 * them: `seed` for a new database, and `init`'s v10 step for one that predates
 * the BBC section feeds.
 */
import type { Database } from 'better-sqlite3';
import type { Category } from '../core/article.js';

export interface SeededSource {
  id: string;
  name: string;
  url: string;
  enabled: 0 | 1;
  trustLevel: 'high' | 'medium' | 'low';
  parser: string | null;
  /** NULL: the feed mixes subjects, so each story's category is guessed. */
  category: Category | null;
}

/** The BBC front page. Seeded as 'rss' before v10; init upgrades an untouched row. */
export const BBC_FRONT_PAGE_FEED = 'https://feeds.bbci.co.uk/news/rss.xml';

/**
 * One source per BBC section, so each can be switched off on its own and every
 * story arrives already knowing its subject.
 *
 * Business has no category of its own in the reader UI, so it is filed under
 * World. Science & Environment mixes both subjects, so it is left to the guess.
 */
export const BBC_SECTION_SOURCES: readonly SeededSource[] = [
  { id: 'bbc-technology', name: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', enabled: 1, trustLevel: 'high', parser: 'bbc', category: 'Technology' },
  { id: 'bbc-business', name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', enabled: 1, trustLevel: 'high', parser: 'bbc', category: 'World' },
  { id: 'bbc-health', name: 'BBC Health', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', enabled: 1, trustLevel: 'high', parser: 'bbc', category: 'Health' },
  { id: 'bbc-science', name: 'BBC Science & Environment', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', enabled: 1, trustLevel: 'high', parser: 'bbc', category: null },
  { id: 'bbc-sport', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml', enabled: 1, trustLevel: 'high', parser: 'bbc', category: 'Sports' },
];

/**
 * PRD §5.1 prototype list, plus the BBC sections and the 'manual' row that
 * editor submissions (§4.3) point at so raw_articles.sourceId is always a real
 * foreign key.
 *
 * Only BBC carries live feed URLs: §5.2 names it the first production source.
 * The other four are seeded disabled with a blank url so the first scraper run
 * is honest rather than half-broken — fill in a real feed URL in
 * /admin/settings, then enable. (This is why reuters/ap-news/npr are
 * enabled = 0 here despite §5.1 listing them as enabled; CNN is disabled in
 * §5.1 too.)
 */
export const SEEDED_SOURCES: readonly SeededSource[] = [
  { id: 'bbc', name: 'BBC News', url: BBC_FRONT_PAGE_FEED, enabled: 1, trustLevel: 'high', parser: 'bbc', category: null },
  ...BBC_SECTION_SOURCES,
  { id: 'reuters', name: 'Reuters', url: '', enabled: 0, trustLevel: 'high', parser: 'rss', category: null },
  { id: 'ap-news', name: 'Associated Press', url: '', enabled: 0, trustLevel: 'high', parser: 'rss', category: null },
  { id: 'npr', name: 'NPR', url: '', enabled: 0, trustLevel: 'high', parser: 'rss', category: null },
  { id: 'cnn', name: 'CNN', url: '', enabled: 0, trustLevel: 'medium', parser: 'rss', category: null },
  { id: 'manual', name: 'Manual submission', url: '', enabled: 0, trustLevel: 'high', parser: null, category: null },
];

/**
 * Inserts a source unless its id exists, and returns how many rows changed
 * (0 or 1). Never overwrites: an editor's changes to a seeded row survive.
 */
export function prepareSourceInsert(db: Database): (source: SeededSource, now: string) => number {
  const insert = db.prepare(
    `INSERT INTO sources (id, name, url, enabled, trustLevel, parser, category, createdAt, updatedAt)
     VALUES (@id, @name, @url, @enabled, @trustLevel, @parser, @category, @now, @now)
     ON CONFLICT (id) DO NOTHING`,
  );
  return (source, now) => insert.run({ ...source, now }).changes;
}
