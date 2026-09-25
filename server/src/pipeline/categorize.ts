/**
 * A first guess at a story's category, from keywords alone.
 *
 * Feeds rarely say what a story is about — the BBC front-page feed carries no
 * category at all — so without this every scraped story landed in 'World'.
 * The guess is stored as RawArticle.topic at scrape time. It is free and works
 * without an API key, which makes it the category the rule-based pipeline
 * (§9.2) uses; when the LLM runs, it picks the category itself and this guess
 * is only the hint it is shown as {{category}}.
 *
 * Deliberately rough. 'Good News' is never guessed: it is a judgement about
 * the story's tone, not a subject any word list can spot.
 */
import { DEFAULT_CATEGORY, type Category } from '../core/article.js';

const KEYWORDS: Partial<Record<Category, readonly string[]>> = {
  Sports: [
    'football', 'cricket', 'tennis', 'rugby', 'basketball', 'golf', 'athletics', 'olympic',
    'olympics', 'paralympic', 'world cup', 'premier league', 'wimbledon', 'tournament',
    'championship', 'league', 'athlete', 'medal', 'stadium', 'goalkeeper', 'formula 1',
  ],
  Science: [
    'scientist', 'scientists', 'research', 'researchers', 'space', 'nasa', 'planet', 'telescope',
    'astronaut', 'fossil', 'dinosaur', 'experiment', 'moon', 'mars', 'species', 'discovery',
  ],
  Environment: [
    'climate', 'environment', 'pollution', 'wildlife', 'forest', 'ocean', 'carbon', 'emissions',
    'recycling', 'drought', 'heatwave', 'flood', 'flooding', 'conservation', 'plastic',
    'renewable', 'endangered', 'biodiversity',
  ],
  Health: [
    'health', 'hospital', 'doctor', 'doctors', 'nurse', 'nurses', 'nhs', 'disease', 'vaccine',
    'virus', 'medicine', 'patients', 'illness', 'cancer',
  ],
  Technology: [
    'technology', 'artificial intelligence', 'ai', 'robot', 'robots', 'smartphone', 'computer',
    'internet', 'software', 'app', 'video game', 'gaming', 'cyber', 'chip',
  ],
  Culture: [
    'film', 'movie', 'music', 'singer', 'album', 'artist', 'museum', 'author', 'novel', 'theatre',
    'festival', 'television', 'concert', 'dance', 'painting',
  ],
};

/** Whole word or phrase, case-insensitive, with an optional plural — as the deny-list matches. */
const matcher = (term: string) =>
  new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?\\b`, 'i');

const MATCHERS = Object.entries(KEYWORDS).map(([category, terms]) => ({
  category: category as Category,
  matchers: terms.map(matcher),
}));

/**
 * The category whose keywords the story mentions most, counting distinct
 * terms: a headline hit counts double, because a headline states what the
 * story is about and a body wanders. No hit at all is DEFAULT_CATEGORY; a tie
 * goes to the category listed first.
 */
export function guessCategory(headline: string, body: string): Category {
  let best: Category = DEFAULT_CATEGORY;
  let bestScore = 0;

  for (const { category, matchers } of MATCHERS) {
    const score = matchers.reduce(
      (sum, re) => sum + (re.test(headline) ? 2 : 0) + (re.test(body) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}
