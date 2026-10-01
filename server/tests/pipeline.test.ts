/** Guard and reading-band rules — PRD §6, §3.6 and §9.2. Pure logic; no HTTP, no network. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGE_BANDS, AGE_BAND_ANCHORS, bandForAge, formatAgeBand, isAgeBandAnchor,
} from '../src/core/article.js';
import { denyListGuard, leadOf, strictest } from '../src/pipeline/guard.js';
import { maxWordsForAge } from '../src/pipeline/simplify.js';
import { loadPipelineConfig } from '../src/pipeline/simplifyArticle.js';
import { createTestContext, type TestContext } from './helpers.js';

const DEFAULT_DENY = ['war','killed','death','shooting','attack','bomb','disaster','earthquake','violence','conflict','wounded'];

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

describe('leadOf: how much of a body the deny-list reads', () => {
  it('returns a short text unchanged', () => {
    expect(leadOf('A short story.', 600)).toBe('A short story.');
  });

  it('cuts at whitespace, never through a word', () => {
    // A halved "warm" would read as "war".
    expect(leadOf('The day was warm', 14)).toBe('The day was');
  });

  it('keeps a word that ends exactly at the limit', () => {
    expect(leadOf('The day was warm and sunny', 16)).toBe('The day was warm');
  });

  it('hard-cuts a text with no whitespace at all', () => {
    expect(leadOf('x'.repeat(20), 10)).toBe('x'.repeat(10));
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

describe('reading bands (§3.6, §9.2)', () => {
  it('cover 5-14 contiguously, ascending, with no overlap', () => {
    expect(AGE_BANDS[0]!.minAge).toBe(5);
    expect(AGE_BANDS[AGE_BANDS.length - 1]!.maxAge).toBe(14);
    for (let i = 1; i < AGE_BANDS.length; i += 1) {
      expect(AGE_BANDS[i]!.minAge).toBe(AGE_BANDS[i - 1]!.maxAge + 1);
    }
  });

  it.each([[5, 5], [6, 5], [7, 5], [8, 8], [9, 8], [10, 8], [11, 11], [12, 11], [13, 11], [14, 11]])(
    'age %i is written for the band anchored at %i',
    (age, anchor) => expect(bandForAge(age).minAge).toBe(anchor),
  );

  it('clamps an out-of-range age to the nearest band rather than throwing', () => {
    expect(bandForAge(3).minAge).toBe(5);
    expect(bandForAge(40).minAge).toBe(11);
  });

  it('recognises exactly the anchors as storable ageTargets', () => {
    expect(AGE_BAND_ANCHORS).toEqual([5, 8, 11]);
    expect(isAgeBandAnchor(8)).toBe(true);
    expect(isAgeBandAnchor(6)).toBe(false);
  });

  it('formats a band as a range', () => {
    expect(formatAgeBand(bandForAge(9))).toBe('8–10');
  });
});

describe('words per sentence (§9.2)', () => {
  it.each([[5, 14], [6, 14], [7, 14], [8, 20], [9, 20], [10, 20], [11, 28], [12, 28], [13, 28], [14, 28]])(
    'age %i allows %i words per sentence',
    (age, limit) => expect(maxWordsForAge(age)).toBe(limit),
  );

  it('keeps §9.2’s three stated bands exactly', () => {
    // The PRD gives "<=7 -> 14; <=10 -> 20; else 28", and those are the three
    // reading bands a story is written in (AGE_BANDS).
    expect(maxWordsForAge(7)).toBe(14);
    expect(maxWordsForAge(10)).toBe(20);
    expect(maxWordsForAge(14)).toBe(28);
  });

  it('gives every band its own limit, so the three versions really differ', () => {
    const limits = AGE_BANDS.map((band) => maxWordsForAge(band.minAge));
    expect(new Set(limits).size).toBe(AGE_BANDS.length);
  });
});

describe('loadPipelineConfig', () => {
  let ctx: TestContext;
  beforeAll(() => { ctx = createTestContext(); });
  afterAll(() => ctx.close());

  it('reads the deny-list from guard_config, not from code', () => {
    ctx.db.prepare(`UPDATE guard_config SET denyList = ?, denyListEnabled = 0 WHERE id='default'`)
      .run(JSON.stringify(['volcano']));
    expect(loadPipelineConfig(ctx.db)).toMatchObject({ denyList: ['volcano'], denyListEnabled: false });
  });

  it('writes for the band the default age falls in, unless given one', () => {
    expect(loadPipelineConfig(ctx.db).ageTarget).toBe(5);
    expect(loadPipelineConfig(ctx.db, 11).ageTarget).toBe(11);
  });
});
