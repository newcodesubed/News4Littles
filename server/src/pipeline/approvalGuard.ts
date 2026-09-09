/**
 * The auto-mode judge: does this story look fit for a child to read?
 *
 * Only reached when AUTO_APPROVE_ENABLED is on. §2.2 otherwise promises a human
 * reads every story first, so this is the one place in the codebase that can
 * put words in front of a child without an editor — and it is written to be
 * default-deny.
 *
 * `judgeStory` NEVER throws and NEVER returns approved:true by accident. A
 * timeout, a dead provider, HTML instead of JSON, a missing field, a
 * non-boolean field: all of them come back as a refusal with a reason. The
 * caller publishes only on `approved === true`, so there is no error path that
 * can leak a publish.
 */
import type { KidArticle } from '../core/article.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';

export interface ApprovalVerdict {
  /** True only on an explicit, well-formed yes. */
  approved: boolean;
  /** Always present, so a held story can say why it was held. */
  reason: string;
  costUsd?: number;
}

/**
 * Deliberately not editable from admin settings, unlike the simplification and
 * §6.2 guard prompts. Those shape output; this one decides whether a child sees
 * it at all, and one careless edit here would silently approve everything.
 */
const APPROVAL_PROMPT = `You are the final safety check for a children's news site, reviewing a story written for a 5-year-old before it is published.

HEADLINE: {{kidHeadline}}
SUMMARY: {{summary}}
WHAT HAPPENED: {{whatHappened}}
WHY IT MATTERS: {{whyItMatters}}
THINK ABOUT: {{thinkAbout}}

Refuse the story if ANY of these is true:
- It describes violence, injury, death or cruelty in a way a young child would find frightening.
- It is confusing, or reads as though facts are missing or invented.
- It is not actually written for a young child: long sentences, hard words, or an adult tone.
- The discussion question is unkind, leading, or upsetting.
- Anything about it would make a parent uncomfortable finding it on a children's site.

Approve only if you would be comfortable with a 5-year-old reading it unsupervised.

Return ONLY a JSON object — no markdown fences, no commentary:

{
  "approved": true or false,
  "reason": "One short sentence explaining the decision."
}`;

/** The kid-facing fields the judge is shown. */
type Judged = Pick<
  KidArticle,
  'kidHeadline' | 'summary' | 'whatHappened' | 'whyItMatters' | 'thinkAbout'
>;

function render(article: Judged): string {
  return APPROVAL_PROMPT.replaceAll('{{kidHeadline}}', article.kidHeadline)
    .replaceAll('{{summary}}', article.summary)
    .replaceAll('{{whatHappened}}', article.whatHappened)
    .replaceAll('{{whyItMatters}}', article.whyItMatters)
    .replaceAll('{{thinkAbout}}', article.thinkAbout);
}

export async function judgeStory(
  client: OpenRouterClient,
  article: Judged,
): Promise<ApprovalVerdict> {
  const result = await client.complete({ prompt: render(article) });

  if (!result.ok) {
    return { approved: false, reason: `The judge could not be reached: ${result.reason}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return {
      approved: false,
      reason: 'The judge’s answer was not valid JSON.',
      costUsd: result.costUsd,
    };
  }

  // An explicit boolean true and nothing else. A string 'yes', a 1, a missing
  // field or an array all fall through to a refusal.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { approved: false, reason: 'The judge’s answer was not an object.', costUsd: result.costUsd };
  }

  const { approved, reason } = parsed as { approved?: unknown; reason?: unknown };
  if (approved !== true) {
    return {
      approved: false,
      reason:
        typeof reason === 'string' && reason.trim()
          ? reason.trim()
          : 'The judge did not approve it.',
      costUsd: result.costUsd,
    };
  }

  return {
    approved: true,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'Approved.',
    costUsd: result.costUsd,
  };
}
