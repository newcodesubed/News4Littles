/**
 * Guard / curation pipeline — PRD §6.
 *
 * Only the deny-list guard lives here. The prompt guard (§6.2) needs an LLM and
 * is out of scope, but the strictest-wins combinator below is built to take it
 * as a second input when it arrives.
 */
import type { Safety } from '../core/article.js';

/** Strictness order, least to most restrictive (§6 "Safety semantics"). */
const SEVERITY: Record<Safety, number> = {
  calm: 0,
  'adult-nearby': 1,
  'skip-young': 2,
};

export interface GuardResult {
  guard: string;
  safety: Safety;
  /** Deny-list terms found, in the order they appear in the list. */
  matches: string[];
}

/**
 * Escape a deny-list entry for use in a regex. Entries are editor-managed free
 * text (§6.1 "words/phrases"), so they may contain regex metacharacters.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a deny-list term as a whole word or phrase, case-insensitively, with an
 * optional plural suffix.
 *
 * ASSUMPTION: the trailing (?:e?s)? is not in the PRD. Without it "attack"
 * would miss "attacks" and "death" would miss "deaths", which would badly
 * under-flag real articles. It deliberately does NOT stem further, so "war"
 * still matches only "war"/"wars" — never "warm", "ward" or "warning".
 */
function buildMatcher(term: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(term.trim())}(?:e?s)?\\b`, 'i');
}

/**
 * Deny-list keyword guard — PRD §6.1.
 *   0 matches -> calm | 1-2 -> adult-nearby | 3+ -> skip-young
 *
 * ASSUMPTION: "matches" counts DISTINCT deny-list terms present, not total
 * occurrences. An article that says "war" eight times is one topic and lands on
 * adult-nearby; an article carrying "war" + "killed" + "bomb" covers three and
 * lands on skip-young. Counting occurrences would push almost any article about
 * a single hard subject straight to skip-young.
 */
export function denyListGuard(text: string, denyList: string[]): GuardResult {
  const matches = denyList.filter((term) => term.trim() && buildMatcher(term).test(text));

  let safety: Safety = 'calm';
  if (matches.length >= 3) safety = 'skip-young';
  else if (matches.length >= 1) safety = 'adult-nearby';

  return { guard: 'deny-list', safety, matches };
}

/**
 * §6: "the strictest result wins", over bare verdicts.
 *
 * The one place that knows the severity order. A story's ten age versions, a
 * set of guard results and a review-queue row all need "the worst of these",
 * and three copies of this comparison would be three chances to let a
 * skip-young story present as calm.
 *
 * An empty list is 'calm': no guard said otherwise.
 */
export function strictestSafety(safeties: Safety[]): Safety {
  return safeties.reduce<Safety>(
    (worst, safety) => (SEVERITY[safety] > SEVERITY[worst] ? safety : worst),
    'calm',
  );
}

/** §6: "all enabled guards; the strictest result wins." */
export function strictest(results: GuardResult[]): GuardResult {
  if (results.length === 0) {
    return { guard: 'none', safety: 'calm', matches: [] };
  }
  const worst = strictestSafety(results.map((result) => result.safety));
  // The first result at the winning level, so its `matches` come with it.
  return results.find((result) => result.safety === worst) ?? results[0];
}
