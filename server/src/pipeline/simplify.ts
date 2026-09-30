/** Reading-age limits and fixed texts shared by the model path and the sandbox. */
import { bandForAge } from '../core/article.js';

/**
 * Words per sentence for one reading age — §9.2's three bands: "<=7 -> max 14
 * words/sentence; <=10 -> 20; else 28".
 *
 * The bands are the same ones a story is written in (AGE_BANDS): every age in
 * a band gets the same limit because every age in a band reads the same version.
 */
export function maxWordsForAge(ageTarget: number): number {
  return bandForAge(ageTarget).maxWordsPerSentence;
}

/** Split prose into sentences on . ! ? followed by whitespace; abbreviations split too. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * INVENTED: §6 requires a feelingNote for non-calm stories but supplies no
 * text. Used when the guard raises a story the model thought was calm, so the
 * model wrote no note. Calm stories get none (§3.4, §11.1).
 */
export const FEELING_NOTE_FALLBACK: Record<'adult-nearby' | 'skip-young', string> = {
  'adult-nearby':
    'This story has some hard parts in it. It is a good one to read with a grown-up nearby, so you can ask them anything you are wondering about.',
  'skip-young':
    'This is a hard story, and it is normal to feel worried by it. Lots of people are working to help. Please read it with a grown-up, and tell them how it makes you feel.',
};
