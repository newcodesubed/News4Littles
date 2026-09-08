/**
 * The KidArticle domain type (PRD §8.3) and the translation between the shape
 * SQLite stores and the shape the API speaks.
 *
 * Pure: no express, no better-sqlite3. Both directions live here so the
 * marshalling rules — JSON columns, 0/1 booleans — are stated exactly once.
 */
export interface VocabEntry {
  word: string;
  definition: string;
}

export type Safety = 'calm' | 'adult-nearby' | 'skip-young';
export type ArticleStatus = 'pending_review' | 'published' | 'rejected';

export const SAFETY_VALUES: readonly Safety[] = ['calm', 'adult-nearby', 'skip-young'];
export const ARTICLE_STATUSES: readonly ArticleStatus[] = ['pending_review', 'published', 'rejected'];

/** §4.2's "flagged only" shortcut: both non-calm levels. */
export const FLAGGED_SAFETY: readonly Safety[] = ['adult-nearby', 'skip-young'];

/** §3.6 reading-age range. */
export const MIN_AGE = 5;
export const MAX_AGE = 14;

/** A kid_articles row exactly as better-sqlite3 hands it back. */
export interface KidArticleRow {
  id: string;
  originalId: string;
  ageTarget: number;
  kidHeadline: string;
  summary: string;
  whatHappened: string;
  whyItMatters: string;
  vocab: string;                  // JSON text
  thinkAbout: string;
  feelingNote: string | null;
  safety: Safety;
  contentWarnings: string | null; // JSON text or NULL
  category: string;
  readingMinutes: number;
  sourceName: string;
  sourceUrl: string;
  status: ArticleStatus;
  rejectReason: string | null;
  editedByHuman: number;          // 0 | 1
  createdAt: string;
  publishedAt: string | null;
}

/** The JSON shape sent over the wire — matches PRD §8.3 exactly. */
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

/** Database row -> API object. */
export function toKidArticle(row: KidArticleRow): KidArticle {
  return {
    ...row,
    vocab: JSON.parse(row.vocab) as VocabEntry[],
    contentWarnings:
      row.contentWarnings === null ? null : (JSON.parse(row.contentWarnings) as string[]),
    editedByHuman: row.editedByHuman === 1,
  };
}

/** API object -> database row. The inverse of toKidArticle. */
export function toKidArticleRow(article: KidArticle): KidArticleRow {
  return {
    ...article,
    vocab: JSON.stringify(article.vocab),
    contentWarnings:
      article.contentWarnings && article.contentWarnings.length > 0
        ? JSON.stringify(article.contentWarnings)
        : null,
    editedByHuman: article.editedByHuman ? 1 : 0,
  };
}

export function isArticleStatus(value: string): value is ArticleStatus {
  return (ARTICLE_STATUSES as readonly string[]).includes(value);
}

/**
 * The one safety rule the UI must never get wrong (PRD §3.4, §11.1):
 * a feeling note belongs only to a non-calm story.
 */
export function needsFeelingNote(article: Pick<KidArticle, 'safety'>): boolean {
  return article.safety !== 'calm';
}
