/**
 * Mirrors the API contract served by /server (PRD §8.3).
 *
 * The server already parses JSON-text columns and converts 0/1 to booleans, so
 * these are the shapes that actually arrive over the wire. Optional PRD fields
 * come back as `null`, never absent.
 */

export interface VocabEntry {
  word: string;
  definition: string;
}

export type Safety = 'calm' | 'adult-nearby' | 'skip-young';
export type ArticleStatus = 'pending_review' | 'published' | 'rejected';

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

/**
 * The one safety rule the UI must never get wrong (PRD §3.4, §11.1):
 * the feeling note and the safety badge appear only for non-calm stories.
 */
/**
 * A published story as the public API serves it: one version, chosen for the
 * reader's age. `ageMatched` is false when their age had no version and a
 * nearer one was served, so the UI can say so rather than implying a match.
 */
export interface PublicArticle extends KidArticle {
  ageMatched: boolean;
}

export function needsFeelingNote(article: Pick<KidArticle, 'safety'>): boolean {
  return article.safety !== 'calm';
}
