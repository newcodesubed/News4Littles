/**
 * Starter LLM prompt text seeded into translation_prompt_config (PRD §8.5).
 *
 * The PRD specifies what these prompts must achieve (§9.1 JSON output, §3.4
 * story sections, §7.3 template variables) but never gives the wording, so this
 * is a written-from-the-spec starting point — NOT a tuned production prompt.
 * The whole purpose of the sandbox (§7) is that editors rewrite these and
 * promote new versions; seeding them empty would leave nothing to test against.
 *
 * Template variables available (§7.3): {{headline}}, {{body}}, {{category}},
 * {{sourceName}}, {{age}}.
 *
 * NOTE: an age override REPLACES the generic prompt rather than extending it
 * (§9.1: "age-specific override if it exists, else generic"), so each override
 * must be a complete, standalone prompt.
 *
 * The safety criteria below are deliberately explicit. With only the three-line
 * description they replaced, a real model rated a story about four people killed
 * and eleven wounded as "calm" — 2 of 5 test articles classified correctly. With
 * these criteria it was 5 of 5, in the same single call.
 */

export const GENERIC_SIMPLIFICATION_PROMPT = `You are rewriting a real news story for a {{age}}-year-old child.

SOURCE: {{sourceName}}
CATEGORY: {{category}}
HEADLINE: {{headline}}

ARTICLE:
{{body}}

Rules:
- Stay true to the article. Never invent facts, numbers, names or quotes. If the article does not say something, leave it out.
- Write calmly. Do not sensationalise and do not frighten.
- Keep sentences short and use everyday words a {{age}}-year-old knows.
- Do not describe violence, injury or death in detail. State plainly that it happened and move on.
- Explain any word a {{age}}-year-old is unlikely to know.

Return ONLY a JSON object — no markdown fences, no commentary — in exactly this shape:

{
  "kidHeadline": "Short and friendly. Not clickbait.",
  "summary": "One sentence describing the story.",
  "whatHappened": "Two to four short sentences on what actually happened.",
  "whyItMatters": "Two or three short sentences on why it is interesting or important.",
  "vocab": [{ "word": "reef", "definition": "A ridge of coral or rock near the surface of the sea." }],
  "thinkAbout": "One open question inviting the child to think or talk about the story.",
  "feelingNote": "One or two reassuring sentences, but ONLY if the story could worry a child. Otherwise null.",
  "safety": "calm",
  "contentWarnings": [],
  "readingMinutes": 3
}

Field notes:
- "safety" must be exactly one of "calm", "adult-nearby" or "skip-young".

  Judge the SUBJECT of the story, not how gently you rewrote it. A kind rewrite
  of a hard story is still a hard story.

  "skip-young" — the story is centrally about war or armed conflict, killing or
    death, a shooting, bombing or attack, serious violence, a disaster with
    casualties, or people being seriously hurt.
  "adult-nearby" — not violent, but a child could still find it worrying or
    confusing: people losing their jobs, families losing homes or being
    separated, serious illness, a frightening accident, crime, political
    conflict, harm to the climate or to animals, anyone in danger.
  "calm" — nothing in the subject would worry a child: discovery, science,
    sport, culture, animals, food, achievement, everyday life.

  If you are unsure between two levels, choose the STRICTER one.

- "feelingNote" must be null when "safety" is "calm", and must be written when
  it is not.
- "contentWarnings" holds short labels for anything a grown-up should know about,
  or an empty list.
- "vocab" holds two to four words that ACTUALLY APPEAR in the story. Never proper
  nouns, brand names or people's names — choose words a child would need
  explained.
- "readingMinutes" is a whole number, at least 1.`;

export const AGE_6_SIMPLIFICATION_PROMPT = `You are rewriting a real news story for a 6-year-old child who is just learning to read.

SOURCE: {{sourceName}}
CATEGORY: {{category}}
HEADLINE: {{headline}}

ARTICLE:
{{body}}

Rules:
- Stay true to the article. Never invent facts, numbers, names or quotes.
- Every sentence must be 14 words or fewer.
- Use simple, common words. Avoid "actually", "essentially", "moreover", "furthermore", "subsequently".
- Be warm and calm. Never frightening.
- Do not describe violence, injury or death. If the story is about those things, keep it to a single gentle sentence.
- Prefer concrete things a 6-year-old can picture over abstract ideas.

Return ONLY a JSON object — no markdown fences, no commentary — in exactly this shape:

{
  "kidHeadline": "Short, warm, and easy to read out loud.",
  "summary": "One short sentence.",
  "whatHappened": "Two or three very short sentences.",
  "whyItMatters": "One or two very short sentences.",
  "vocab": [{ "word": "reef", "definition": "A long line of rock and coral under the sea." }],
  "thinkAbout": "One simple question a grown-up could ask at the dinner table.",
  "feelingNote": "One gentle, reassuring sentence, but ONLY if the story could worry a child. Otherwise null.",
  "safety": "calm",
  "contentWarnings": [],
  "readingMinutes": 2
}

Field notes:
- "safety" must be exactly one of "calm", "adult-nearby" or "skip-young".

  Judge the SUBJECT of the story, not how gently you rewrote it.

  "skip-young" — war or armed conflict, killing or death, a shooting, bombing or
    attack, serious violence, a disaster with casualties, people badly hurt.
  "adult-nearby" — not violent, but still worrying for a child: people losing
    jobs or homes, families separated, serious illness, a frightening accident,
    crime, political conflict, harm to the climate or to animals.
  "calm" — nothing in the subject would worry a child.

  If you are unsure between two levels, choose the STRICTER one.

- "feelingNote" must be null when "safety" is "calm", and must be written when
  it is not.
- "vocab" holds exactly two words that appear in the story, each explained in
  under 12 words. Never proper nouns, brand names or people's names.
- "readingMinutes" is a whole number, at least 1.`;
