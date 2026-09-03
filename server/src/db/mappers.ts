/**
 * Row <-> API translation for kid_articles.
 *
 * The database stores what SQLite can store; the API returns what PRD §8.3
 * declares. Two conversions are needed on the way out:
 *   - JSON-text columns (vocab, contentWarnings) -> real arrays
 *   - INTEGER 0/1 (editedByHuman) -> real boolean
 *
 * Optional PRD fields (`field?`) are returned as null rather than omitted, so
 * the frontend can read every key without existence checks.
 */

export interface VocabEntry {
  word: string;
  definition: string;
}

export type Safety = 'calm' | 'adult-nearby' | 'skip-young';
export type ArticleStatus = 'pending_review' | 'published' | 'rejected';

export const ARTICLE_STATUSES: readonly ArticleStatus[] = [
  'pending_review',
  'published',
  'rejected',
];

/** A kid_articles row exactly as better-sqlite3 hands it back. */
export interface KidArticleRow {
  id: string;
  originalId: string;
  ageTarget: number;
  kidHeadline: string;
  summary: string;
  whatHappened: string;
  whyItMatters: string;
  vocab: string;             // JSON text
  thinkAbout: string;
  feelingNote: string | null;
  safety: Safety;
  contentWarnings: string | null;  // JSON text or NULL
  category: string;
  readingMinutes: number;
  sourceName: string;
  sourceUrl: string;
  status: ArticleStatus;
  rejectReason: string | null;
  editedByHuman: number;     // 0 | 1
  createdAt: string;
  publishedAt: string | null;
}

/** The JSON shape sent over the wire — matches PRD §8.3 KidArticle. */
export interface KidArticle {
  id: string;
  originalId: string;
  ageTarget: number;
  kidHeadline: string;
  summary: string;
  whatHappened: string;
  whyItMatters: string;
  vocab: VocabEntry[];
  thinkAbout: string;
  feelingNote: string | null;
  safety: Safety;
  contentWarnings: string[] | null;
  category: string;
  readingMinutes: number;
  sourceName: string;
  sourceUrl: string;
  status: ArticleStatus;
  rejectReason: string | null;
  editedByHuman: boolean;
  createdAt: string;
  publishedAt: string | null;
}

export function toKidArticle(row: KidArticleRow): KidArticle {
  return {
    ...row,
    vocab: JSON.parse(row.vocab) as VocabEntry[],
    contentWarnings: row.contentWarnings === null
      ? null
      : (JSON.parse(row.contentWarnings) as string[]),
    editedByHuman: row.editedByHuman === 1,
  };
}

export function isArticleStatus(value: string): value is ArticleStatus {
  return (ARTICLE_STATUSES as readonly string[]).includes(value);
}
