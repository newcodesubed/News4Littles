/**
 * Local guard + simplification pipeline — PRD §6 and §9.2.
 * Pure logic; no HTTP, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { denyListGuard, strictest } from '../src/pipeline/guard.js';
import {
  buildVocab, capitalize, maxWordsForAge, simplifyHeadline, simplifySentences,
  stripComplexWords, truncateSentence,
} from '../src/pipeline/simplify.js';
import { loadLocalPipelineConfig, simplifyLocally } from '../src/pipeline/localPipeline.js';
import { createTestContext, type TestContext } from './helpers.js';

const DEFAULT_DENY = ['war','killed','death','shooting','attack','bomb','disaster','earthquake','violence','conflict','wounded'];

const RAW = {
  id: 'r1', headline: 'Adult headline', body: 'A rover found a reef.',
  topic: 'World', sourceName: 'BBC News', sourceUrl: 'https://example.com/a',
};

describe('deny-list guard thresholds (§6.1)', () => {
  it.each([
    ['no deny-list words', 'A calm story about a coral reef.', 'calm'],
    ['one word', 'There was an earthquake.', 'adult-nearby'],
    ['two words', 'An earthquake and a disaster.', 'adult-nearby'],
    ['three words', 'War, an attack and a bomb.', 'skip-young'],
    ['four words', 'War, attack, bomb, violence.', 'skip-young'],
  ])('%s -> %s', (_label, text, expected) => {
    expect(denyListGuard(text, DEFAULT_DENY).safety).toBe(expected);
  });

  it('counts DISTINCT words, not occurrences', () => {
    // Eight mentions of one topic is still one topic.
    expect(denyListGuard('war war war war war war war war', DEFAULT_DENY).safety).toBe('adult-nearby');
  });
});

describe('deny-list matching rules', () => {
  it('is case-insensitive', () => {
    expect(denyListGuard('WAR broke out.', DEFAULT_DENY).matches).toContain('war');
  });

  it('matches plurals', () => {
    expect(denyListGuard('Two attacks happened.', DEFAULT_DENY).matches).toEqual(['attack']);
    expect(denyListGuard('Several deaths.', DEFAULT_DENY).matches).toContain('death');
  });

  it.each(['It was a warm day.', 'A weather warning.', 'The warden spoke.', 'They went toward it.'])(
    'does NOT match a longer word containing a deny term: %s',
    (text) => expect(denyListGuard(text, DEFAULT_DENY).matches).toHaveLength(0),
  );

  it('supports multi-word phrases', () => {
    expect(denyListGuard('There was armed conflict today.', ['armed conflict']).matches).toHaveLength(1);
  });

  it('treats regex metacharacters literally', () => {
    expect(denyListGuard('a+b happened', ['a+b']).matches).toHaveLength(1);
  });

  it('ignores blank entries and an empty list', () => {
    expect(denyListGuard('hello', ['', '  ']).matches).toHaveLength(0);
    expect(denyListGuard('war attack bomb', []).safety).toBe('calm');
  });
});

describe('strictest-wins combinator (§6)', () => {
  it('picks the harshest verdict', () => {
    expect(strictest([
      { guard: 'a', safety: 'calm', matches: [] },
      { guard: 'b', safety: 'skip-young', matches: [] },
    ]).safety).toBe('skip-young');
  });

  it('defaults to calm when no guard ran', () => {
    expect(strictest([]).safety).toBe('calm');
  });
});

describe('sentence simplification (§9.2)', () => {
  it.each([[5, 14], [7, 14], [8, 20], [10, 20], [11, 28], [14, 28]])(
    'age %i allows %i words per sentence',
    (age, limit) => expect(maxWordsForAge(age)).toBe(limit),
  );

  it('leaves a sentence at exactly the limit untouched', () => {
    // 14 words exactly.
    const sentence = 'A survey team documented a coral reef at a depth of nine hundred metres';
    expect(sentence.split(' ')).toHaveLength(14);
    expect(truncateSentence(sentence, 14)).toBe(sentence);
  });

  it('truncates without leaving a dangling function word', () => {
    // Cutting at 11 would end on "of"; it backs off to the last real word.
    expect(truncateSentence('A survey team documented a coral reef at a depth of nine hundred metres', 11))
      .toBe('A survey team documented a coral reef at a depth.');
  });

  it('leaves a short sentence alone', () => {
    expect(truncateSentence('Short enough.', 14)).toBe('Short enough.');
  });

  it.each(['actually', 'essentially', 'moreover', 'furthermore', 'subsequently'])(
    'strips the complex word "%s"',
    (word) => expect(stripComplexWords(`It ${word} rained.`)).not.toMatch(new RegExp(word, 'i')),
  );

  it('removes both commas around a bracketed aside', () => {
    expect(stripComplexWords('The sky was, moreover, grey.')).toBe('The sky was grey.');
  });

  it('re-capitalises when the stripped word was first', () => {
    expect(simplifySentences('Moreover, researchers agreed.', 8)).toEqual(['Researchers agreed.']);
  });

  it('capitalize leaves the rest of the sentence untouched', () => {
    expect(capitalize('the BBC said')).toBe('The BBC said');
  });
});

describe('headline simplification (§9.2)', () => {
  it.each([
    ['Watch: Moment workers are rescued', 'Moment workers are rescued'],
    ['Weekly quiz: What is the answer?', 'What is the answer?'],
    ['Coastal towns move to shelters: officials warn of flooding', 'Coastal towns move to shelters'],
    ['Border talks stall again | Analysis', 'Border talks stall again'],
    ['Team documents a coral reef — researchers call it remarkable', 'Team documents a coral reef'],
    ['A plain headline with no separators', 'A plain headline with no separators'],
  ])('%s -> %s', (input, expected) => {
    expect(simplifyHeadline(input, 10)).toBe(expected);
  });

  /**
   * Documents the current boundary rather than endorsing it: a left side of
   * THREE words or fewer is treated as a prefix label and dropped. Every BBC
   * prefix actually observed was 1-2 words ("Watch", "Weekly quiz", "The
   * Papers"), so a genuine three-word headline is collateral damage here.
   * Pinned so that changing PREFIX_LABEL_MAX_WORDS is a deliberate act.
   */
  it('treats a three-word left side as a prefix label (known boundary)', () => {
    expect(simplifyHeadline('Storm nears coast: officials warn of flooding', 10))
      .toBe('Officials warn of flooding');
  });

  it('keeps a four-word left side', () => {
    expect(simplifyHeadline('Storm nears the coast: officials warn of flooding', 10))
      .toBe('Storm nears the coast');
  });
});

describe('vocabulary (§9.2)', () => {
  it('only includes words present in the text', () => {
    expect(buildVocab('The rover filmed a reef.').map((v) => v.word)).toEqual(['rover', 'reef']);
  });

  it('orders by first appearance, not dictionary order', () => {
    expect(buildVocab('The rover found a crater near the reef.').map((v) => v.word))
      .toEqual(['rover', 'crater', 'reef']);
  });

  it('caps at three entries', () => {
    expect(buildVocab('A robot, a satellite, a glacier, a reef and a treaty.')).toHaveLength(3);
  });

  it('falls back when no dictionary word appears', () => {
    expect(buildVocab('Two teams played football.').map((v) => v.word)).toEqual(['news', 'source']);
  });

  it('is deterministic', () => {
    const text = 'The rover found a crater near the reef.';
    expect(buildVocab(text)).toEqual(buildVocab(text));
  });
});

describe('simplifyLocally', () => {
  let ctx: TestContext;
  beforeAll(() => { ctx = createTestContext(); });
  afterAll(() => ctx.close());

  const run = (overrides = {}, age = 6) =>
    simplifyLocally({ ...RAW, ...overrides }, loadLocalPipelineConfig(ctx.db, age),
      { id: 'fixed', now: '2026-01-01T00:00:00.000Z' }).article;

  it('produces every §8.3 field', () => {
    const article = run();
    for (const key of ['id','originalId','ageTarget','kidHeadline','summary','whatHappened','whyItMatters',
      'vocab','thinkAbout','feelingNote','safety','contentWarnings','category','readingMinutes',
      'sourceName','sourceUrl','status','rejectReason','editedByHuman','createdAt','publishedAt']) {
      expect(article).toHaveProperty(key);
    }
  });

  it('never auto-publishes (§5.2 step 7)', () => {
    const article = run({ body: 'A war, an attack and a bomb.' });
    expect(article.status).toBe('pending_review');
    expect(article.publishedAt).toBeNull();
  });

  it('gives a calm story no feeling note', () => {
    expect(run().feelingNote).toBeNull();
  });

  it('gives a non-calm story a feeling note', () => {
    expect(run({ body: 'A war, an attack and a bomb.' }).feelingNote).toBeTruthy();
  });

  it('reports matched deny-list terms as content warnings', () => {
    expect(run({ body: 'A war, an attack and a bomb.' }).contentWarnings).toEqual(['war', 'attack', 'bomb']);
  });

  it('maps RawArticle.topic to category (§8.2)', () => {
    expect(run({ topic: 'Science' }).category).toBe('Science');
  });

  it('is deterministic for the same input', () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('respects the age word limit end to end', () => {
    const article = run({ body: `${'word '.repeat(60).trim()}.` }, 6);
    const longest = article.whatHappened.split(/(?<=[.!?])\s+/)
      .reduce((max, s) => Math.max(max, s.split(/\s+/).filter(Boolean).length), 0);
    expect(longest).toBeLessThanOrEqual(14);
  });

  it('survives an empty body', () => {
    expect(run({ body: '' }).summary.length).toBeGreaterThan(0);
  });

  it('reads the deny-list from guard_config, not from code', () => {
    ctx.db.prepare(`UPDATE guard_config SET denyList = ? WHERE id='default'`).run(JSON.stringify(['volcano']));
    expect(run({ body: 'A volcano erupted.' }).safety).toBe('adult-nearby');

    ctx.db.prepare(`UPDATE guard_config SET denyListEnabled = 0 WHERE id='default'`).run();
    expect(run({ body: 'A volcano erupted.' }).safety).toBe('calm');

    ctx.db.prepare(`UPDATE guard_config SET denyList = ?, denyListEnabled = 1 WHERE id='default'`)
      .run(JSON.stringify(DEFAULT_DENY));
  });
});
