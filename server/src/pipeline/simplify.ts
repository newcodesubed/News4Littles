/**
 * Local simplification helpers — PRD §9.2.
 *
 * Deterministic and dependency-free: no LLM, no network, no clock, no database.
 * Everything here is a pure function of its arguments.
 */
import type { VocabEntry } from '../core/article.js';

/**
 * Words per sentence for one reading age.
 *
 * §9.2 states three bands: "<=7 -> max 14 words/sentence; <=10 -> 20; else 28".
 * A story now exists in one version per age (5-14), so three bands would make
 * ages 5, 6 and 7 byte-identical and the reading-age slider would still change
 * nothing across most of its travel.
 *
 * `age * 2` reproduces all three of §9.2's anchors exactly — 7 -> 14, 10 -> 20,
 * 14 -> 28 — while giving every age its own limit. Ages below an anchor do get
 * shorter sentences than before (age 5 goes from 14 to 10), which is the point.
 */
export function maxWordsForAge(ageTarget: number): number {
  return ageTarget * 2;
}

/**
 * §9.2: "Filter complex words". The PRD gives a closed list of five; it is not
 * an "e.g." list, so nothing extra is added here.
 */
export const COMPLEX_WORDS = [
  'actually',
  'essentially',
  'moreover',
  'furthermore',
  'subsequently',
] as const;

const COMPLEX_WORDS_ALTERNATION = COMPLEX_WORDS.join('|');

/**
 * A complex word used as a bracketed aside ("The sky was, moreover, grey")
 * carries a comma on BOTH sides. Removing only the trailing one strands the
 * leading comma, so this pair is matched and removed together, first.
 */
const BRACKETED_PATTERN = new RegExp(
  `\\s*,\\s*\\b(?:${COMPLEX_WORDS_ALTERNATION})\\b\\s*,\\s*`,
  'gi',
);

/** Every other position: the word plus any comma and spacing that follow it. */
const COMPLEX_WORDS_PATTERN = new RegExp(
  `\\b(?:${COMPLEX_WORDS_ALTERNATION})\\b,?\\s*`,
  'gi',
);

/**
 * Remove the complex words, then tidy the seams they leave behind: a stripped
 * leading word would otherwise leave a lowercase sentence start or a doubled
 * space.
 */
export function stripComplexWords(text: string): string {
  return text
    .replace(BRACKETED_PATTERN, ' ')
    .replace(COMPLEX_WORDS_PATTERN, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

/**
 * Split prose into sentences on . ! ? followed by whitespace.
 *
 * KNOWN LIMITATION: this splits on abbreviations too ("U.S. officials" becomes
 * two sentences). Acceptable for a rule-based fallback whose whole job is to be
 * predictable; the LLM path (§9.1) is what handles prose properly.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Upper-case the first letter, leaving the rest of the sentence alone. */
export function capitalize(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Words that must not be left at the end of a truncated sentence. Cutting at a
 * fixed word count regularly lands mid-phrase ("at a depth of."), so any
 * trailing function words are dropped back to the last word that can close a
 * sentence.
 *
 * ASSUMPTION: not in the PRD. Without it the age-6 output reads as broken
 * English, which defeats the point of simplifying for a young reader.
 */
const DANGLING_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'so', 'yet',
  'of', 'at', 'in', 'on', 'to', 'for', 'with', 'from', 'by', 'as', 'into',
  'onto', 'over', 'under', 'about', 'after', 'before', 'between', 'through',
  'that', 'which', 'who', 'whom', 'whose', 'than', 'then', 'because', 'while',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'its', 'their', 'his', 'her', 'our', 'your', 'my',
  'more', 'most', 'very', 'such', 'per',
]);

/**
 * Cut a sentence to at most `maxWords` words and close it with a full stop.
 *
 * ASSUMPTION: the PRD says "truncation" without saying how the cut should read.
 * A hard cut is used (no ellipsis), because an ellipsis tells a child the
 * sentence is unfinished without telling them what was lost.
 */
export function truncateSentence(sentence: string, maxWords: number): string {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return sentence;

  const kept = words.slice(0, maxWords);
  while (
    kept.length > 1 &&
    DANGLING_WORDS.has(kept[kept.length - 1]!.toLowerCase().replace(/[^a-z]/g, ''))
  ) {
    kept.pop();
  }

  return `${kept.join(' ').replace(/[,;:.!?]+$/, '')}.`;
}

/** Strip complex words, then truncate every sentence to the age limit. */
export function simplifySentences(text: string, ageTarget: number): string[] {
  const maxWords = maxWordsForAge(ageTarget);
  return splitSentences(stripComplexWords(text)).map((sentence) =>
    capitalize(truncateSentence(sentence, maxWords)),
  );
}

/**
 * Headline simplification — PRD §9.2.
 *
 * INVENTED: §9.2 lists "Headline simplification" as a bullet with no rule at
 * all — no length, no transformation, nothing. These three mechanical steps are
 * my choice and are the most likely thing you'll want to change:
 *   1. drop any subtitle after a colon, dash or pipe (news headlines bolt the
 *      detail on after a separator, and the first half is the story)
 *   2. remove the §9.2 complex words
 *   3. truncate to the age word limit, capped at 12 words so a headline stays
 *      a headline even for a 14-year-old
 * Deliberately does NOT add exclamation marks or rephrase — a rule-based pass
 * cannot do that without risking a false claim about the story.
 */
/**
 * A colon does one of two opposite jobs in a news headline:
 *
 *   "Watch: Moment workers are rescued"          -> a PREFIX LABEL; the story
 *                                                   is on the RIGHT
 *   "Storm nears coast: officials warn of..."    -> a SUBTITLE; the story is
 *                                                   on the LEFT
 *
 * Real BBC output settles it: prefixes are short ("Watch", "Weekly quiz", "The
 * Papers") while a meaningful left side runs longer. So a left side of three
 * words or fewer is treated as a label and dropped; anything longer is kept and
 * the subtitle dropped instead.
 *
 * A spaced dash or a pipe is always a suffix ("... | Analysis"), so the left
 * side always wins there.
 */
const PREFIX_LABEL_MAX_WORDS = 3;

function dropHeadlineExtras(headline: string): string {
  // Suffixes first: " — extra" and " | Analysis" never carry the story.
  const withoutSuffix = headline.split(/\s+[-–—|]\s+/)[0]?.trim() ?? headline;

  const colon = withoutSuffix.indexOf(':');
  if (colon === -1) return withoutSuffix;

  const before = withoutSuffix.slice(0, colon).trim();
  const after = withoutSuffix.slice(colon + 1).trim();

  if (!after) return before;
  if (!before) return after;

  return before.split(/\s+/).filter(Boolean).length <= PREFIX_LABEL_MAX_WORDS ? after : before;
}

export function simplifyHeadline(headline: string, ageTarget: number): string {
  const withoutSubtitle = dropHeadlineExtras(headline);
  const cleaned = capitalize(stripComplexWords(withoutSubtitle).replace(/\s*[.,;:]+$/, ''));
  const limit = Math.min(maxWordsForAge(ageTarget), 12);
  const words = cleaned.split(/\s+/).filter(Boolean);

  return words.length <= limit ? cleaned : words.slice(0, limit).join(' ');
}

/**
 * §9.2: "Hard-coded vocab map (treaty, reef, rover, crater, filter, pollution,
 * olympics, vaccine) + fallback vocab."
 *
 * The eight words the PRD names are marked below and kept exactly. The rest is
 * an EXTENSION: eight words match almost no real article (1 of our 8 sample
 * stories), so the "Words to know" panel fell back to generic filler nearly
 * every time. The additions are ordinary news vocabulary a 5-14 year old is
 * likely to meet, grouped by the categories the product actually covers.
 *
 * INVENTED: every definition here is mine — the PRD supplies none.
 * This list is meant to be edited. Adding a word costs one line.
 */
export const VOCAB_MAP: Record<string, string> = {
  // --- the eight named in §9.2 -------------------------------------------
  treaty: 'A written promise between countries to do something, or to stop doing it.',
  reef: 'A long ridge of coral or rock that sits just under the sea.',
  rover: 'A robot with wheels that drives around and explores another planet.',
  crater: 'A big bowl-shaped dent, made when a rock crashes into the ground.',
  filter: 'Something that catches the bits you do not want and lets the rest through.',
  pollution: 'Dirty or harmful stuff that people put into the air, water or land.',
  olympics: 'A huge sports event where the best athletes from many countries compete.',
  vaccine: 'A medicine that teaches your body how to fight an illness before you catch it.',

  // --- World -------------------------------------------------------------
  border: 'The line where one country ends and another one begins.',
  government: 'The group of people who make the rules for a country.',
  election: 'When lots of people vote to choose who is in charge.',
  parliament: 'A big meeting place where a country makes its laws.',
  refugee: 'Someone who has had to leave home because it was not safe to stay.',
  protest: 'When people gather together to show they think something is wrong.',
  shelter: 'A safe place to stay when it is not safe at home.',
  evacuate: 'To leave a place quickly because it has become dangerous.',
  charity: 'A group that collects money and help for people who need it.',
  volunteer: 'Someone who helps out without being paid for it.',

  // --- Environment --------------------------------------------------------
  coral: 'A tiny sea animal that builds a hard, rocky home underwater.',
  climate: 'The kind of weather a place usually gets, year after year.',
  glacier: 'A huge, slow river of ice that moves down a mountain.',
  drought: 'A long time with much less rain than usual.',
  habitat: 'The place where an animal or plant naturally lives.',
  species: 'One particular kind of animal or plant.',
  wildlife: 'The wild animals and plants that live in a place.',
  forest: 'A large area where many trees grow close together.',
  harvest: 'The time when farmers gather the food they have grown.',
  recycle: 'To turn something you have finished with into something new.',
  soil: 'The dirt that plants push their roots into and grow in.',
  solar: 'To do with the sun — like power made from sunshine.',

  // --- Science & space ----------------------------------------------------
  satellite: 'A machine that circles the Earth and sends back pictures or signals.',
  orbit: 'The looping path something takes as it travels around a planet or star.',
  telescope: 'A tube with special glass in it that makes far-away things look close.',
  laboratory: 'A room full of equipment where scientists do their tests.',
  experiment: 'A careful test scientists do to find out whether an idea is true.',
  fossil: 'The shape of a plant or animal left in rock from very long ago.',
  gravity: 'The invisible pull that keeps everything from floating off the ground.',
  planet: 'A huge round world that travels around a star.',
  evidence: 'Facts that show whether something is true.',
  research: 'Careful work to find out more about something.',

  // --- Health -------------------------------------------------------------
  virus: 'A tiny germ, far too small to see, that can make you poorly.',
  medicine: 'Something a doctor gives you to help your body get better.',
  hospital: 'A building where doctors and nurses look after people who are ill.',
  nutrition: 'The good things in food that help your body grow strong.',

  // --- Technology ---------------------------------------------------------
  robot: 'A machine that can do a job on its own.',
  computer: 'A machine that stores information and follows instructions very fast.',
  battery: 'A small store of power that makes something work without a plug.',
  engineer: 'Someone who designs and builds machines, bridges or buildings.',

  // --- Sports -------------------------------------------------------------
  athlete: 'Someone who is very good at a sport and trains a lot.',
  tournament: 'A competition where teams or players keep playing until one wins.',
  champion: 'The person or team that has won a competition.',
  stadium: 'A very big place with lots of seats where people watch sport.',

  // --- Culture ------------------------------------------------------------
  museum: 'A building where interesting or very old things are kept for people to see.',
  festival: 'A special time when lots of people come together to celebrate.',
  tradition: 'Something people have done the same way for a very long time.',
  orchestra: 'A large group of musicians who play their instruments together.',
};

/** INVENTED: the PRD asks for "fallback vocab" without saying what it is. */
export const FALLBACK_VOCAB: VocabEntry[] = [
  {
    word: 'news',
    definition: 'True stories about things that have just happened in the world.',
  },
  {
    word: 'source',
    definition: 'The person or place a piece of news first came from.',
  },
];

/**
 * Pick vocabulary words that actually appear in the article.
 *
 * ASSUMPTION: at most three entries, so a card stays readable. Matching is
 * whole-word and case-insensitive, with an optional plural, matching the guard.
 *
 * Entries come back in the order the words appear in the article, so the vocab
 * follows the story rather than the order this file happens to list them in.
 */
export function buildVocab(text: string, limit = 3): VocabEntry[] {
  const found = Object.entries(VOCAB_MAP)
    .map(([word, definition]) => {
      const match = new RegExp(`\\b${word}(?:e?s)?\\b`, 'i').exec(text);
      return match ? { word, definition, at: match.index } : null;
    })
    .filter((entry): entry is { word: string; definition: string; at: number } => entry !== null)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(({ word, definition }) => ({ word, definition }));

  return found.length > 0 ? found : FALLBACK_VOCAB;
}

/**
 * §9.2: "Fixed why-it-matters and think-about fallbacks."
 *
 * INVENTED: the PRD gives no wording. Both are genuinely fixed strings, as the
 * PRD specifies — no branching on category or safety — so output stays
 * predictable and obviously templated until the LLM path replaces it.
 */
export const WHY_IT_MATTERS_FALLBACK =
  'This story is about something real that happened in the world. Knowing about it helps you understand the people and places around you. A grown-up can help you talk about what it means.';

export const THINK_ABOUT_FALLBACK =
  'What is one thing in this story you would like to know more about?';

/**
 * INVENTED: §6 requires a feelingNote for non-calm stories but supplies no
 * text, and §9.2 does not list one among its fallbacks. One fixed note per
 * non-calm level; calm stories get none (§3.4, §11.1).
 */
export const FEELING_NOTE_FALLBACK: Record<'adult-nearby' | 'skip-young', string> = {
  'adult-nearby':
    'This story has some hard parts in it. It is a good one to read with a grown-up nearby, so you can ask them anything you are wondering about.',
  'skip-young':
    'This is a hard story, and it is normal to feel worried by it. Lots of people are working to help. Please read it with a grown-up, and tell them how it makes you feel.',
};

/**
 * ASSUMPTION: the PRD never says how readingMinutes is derived. 130 words per
 * minute is a typical read-aloud pace for this age range; minimum one minute so
 * a short story never reads as "0 min".
 */
export function estimateReadingMinutes(text: string): number {
  return Math.max(1, Math.round(countWords(text) / 130));
}
