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

/** §3.6 reading-age range — what the public slider offers — and its default. */
export const MIN_AGE = 5;
export const MAX_AGE = 14;
export const DEFAULT_AGE = 6;

/**
 * One reading band: the unit a story is written in.
 *
 * A story is simplified once per BAND, not once per age. §9.2 already splits
 * the range three ways for the rule-based pipeline ("<=7 -> 14 words per
 * sentence; <=10 -> 20; else 28"), and a 6-year-old and a 7-year-old do not
 * need different rewrites — so those three bands are the versions a story has.
 * Three model calls per story instead of ten, and three rows to review.
 *
 * `minAge` doubles as the band's ANCHOR: the value stored in
 * kid_articles.ageTarget and rendered as {{age}} in the prompt. The youngest
 * reader in the band is the one the text is pitched at, because reading down
 * is safer than reading up for a children's product.
 */
export interface AgeBand {
  /** The youngest age in the band; also its anchor (see above). */
  readonly minAge: number;
  readonly maxAge: number;
  /** §9.2's words-per-sentence limit for the rule-based fallback. */
  readonly maxWordsPerSentence: number;
}

/** Every band, ascending and contiguous from MIN_AGE to MAX_AGE (§9.2). */
export const AGE_BANDS: readonly AgeBand[] = [
  { minAge: 5, maxAge: 7, maxWordsPerSentence: 14 },
  { minAge: 8, maxAge: 10, maxWordsPerSentence: 20 },
  { minAge: 11, maxAge: 14, maxWordsPerSentence: 28 },
];

/** The ageTarget values a stored version may carry: one per band. */
export const AGE_BAND_ANCHORS: readonly number[] = AGE_BANDS.map((band) => band.minAge);

/**
 * The band a reader of `age` falls in. Ages outside 5-14 clamp to the nearest
 * band rather than throwing: callers validate first, and a clamp is the
 * behaviour a public read path wants if one slips through.
 */
export function bandForAge(age: number): AgeBand {
  return AGE_BANDS.find((band) => age <= band.maxAge) ?? AGE_BANDS[AGE_BANDS.length - 1]!;
}

/** True when `age` is a band's anchor — a value ageTarget may legitimately hold. */
export function isAgeBandAnchor(age: number): boolean {
  return AGE_BAND_ANCHORS.includes(age);
}

/** "5–7", for labels. */
export function formatAgeBand(band: AgeBand): string {
  return `${band.minAge}–${band.maxAge}`;
}

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
  audioScript: string | null;
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
  audioScript: string | null;
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
