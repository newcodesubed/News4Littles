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

/**
 * The one safety rule the UI must never get wrong (PRD §3.4, §11.1):
 * the feeling note and the safety badge appear only for non-calm stories.
 */
export function needsFeelingNote(article: Pick<KidArticle, 'safety'>): boolean {
  return article.safety !== 'calm';
}

/**
 * GET /api/podcast — the latest day's episode for a reading band.
 *
 * `audioKey` names the audio of exactly this `script`. It is null when there is
 * nothing to play: no stories, or speech switched off on the server.
 */
export interface PodcastEpisode {
  /** Local YYYY-MM-DD the stories were published; null when there are none. */
  date: string | null;
  articles: KidArticle[];
  script: string | null;
  source: 'llm' | 'fallback' | null;
  audioKey: string | null;
}
