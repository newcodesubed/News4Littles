/**
 * The keyword category guess made at scrape time. Rough on purpose — the LLM
 * picks the category when it runs — but it must never file a story under a
 * category the reader UI does not have.
 */
import { describe, expect, it } from 'vitest';
import { CATEGORIES, DEFAULT_CATEGORY } from '../src/core/article.js';
import { guessCategory } from '../src/pipeline/categorize.js';

describe('guessCategory', () => {
  it.each([
    ['Sports', 'England win the World Cup final', 'The team lifted the trophy at the stadium.'],
    ['Science', 'Nasa telescope spots a new planet', 'Scientists were delighted.'],
    ['Environment', 'Heatwave and drought hit farms', 'The climate is changing, experts say.'],
    ['Health', 'New vaccine trial begins at hospital', 'Doctors hope it will help patients.'],
    ['Technology', 'Robot learns to fold laundry', 'The software was written by a small team.'],
    ['Culture', 'Singer releases a new album', 'The music festival starts next week.'],
  ])('files a clear %s story under %s', (category, headline, body) => {
    expect(guessCategory(headline, body)).toBe(category);
  });

  it('falls back to the default category when nothing matches', () => {
    expect(guessCategory('Council meets on Tuesday', 'It was a long meeting.')).toBe(DEFAULT_CATEGORY);
  });

  it('matches whole words only', () => {
    // 'ai' must not fire inside 'said', nor 'app' inside 'happy'.
    expect(guessCategory('She said she was happy', 'Nothing else happened.')).toBe(DEFAULT_CATEGORY);
  });

  it('weighs the headline above a passing mention in the body', () => {
    expect(guessCategory('Football club opens a new stadium', 'The mayor mentioned the museum.')).toBe('Sports');
  });

  it('never guesses Good News — that is a judgement about tone, not a keyword', () => {
    expect(guessCategory('Good news: puppy rescued', 'Everyone was happy and kind.')).not.toBe('Good News');
  });

  it('only ever returns a category the reader UI has', () => {
    const samples = [['', ''], ['Olympic medal', 'athlete'], ['cancer research', 'scientists doctors']];
    for (const [headline, body] of samples) {
      expect(CATEGORIES).toContain(guessCategory(headline, body));
    }
  });
});
