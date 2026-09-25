/**
 * Every seeded prompt text this project has shipped and since replaced.
 *
 * `npm run db:seed` writes the prompts with ON CONFLICT DO NOTHING so it can
 * never overwrite an editor's work — which also means an improved seed never
 * reaches a database that already has one. refreshSeededPrompts.ts closes that
 * gap by recognising a stored prompt that is, byte for byte, one of these
 * retired texts: that prompt is ours and merely out of date, so it is safe to
 * replace with the current seed. Anything else is treated as an editor's work
 * and left alone. An opening-line or marker-phrase heuristic was tried first
 * and either declared stale prompts current or would have overwritten a prompt
 * an editor had edited below its first line; exact text is the only safe test.
 *
 * Whenever a prompt in seed-prompts.ts changes, append the text it replaced
 * here — otherwise databases seeded with it will keep it forever. Never edit
 * an entry: it must stay exactly what was shipped.
 */

// --- Generic prompt (all reading bands) ------------------------------------

/** Written from the spec, per-age, with a three-line safety description. Seeded from 6d2c455. */
export const GENERIC_PROMPT_V1 = `You are rewriting a real news story for a {{age}}-year-old child.

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
  - "calm" — nothing here would upset a child.
  - "adult-nearby" — fine to read, but better with a grown-up nearby.
  - "skip-young" — not suitable for the youngest readers.
- "feelingNote" must be null when "safety" is "calm".
- "contentWarnings" holds short labels for anything a grown-up should know about, or an empty list.
- "vocab" holds two to four words that actually appear in the story.
- "readingMinutes" is a whole number, at least 1.`;

/** Explicit safety criteria; still addressed to a single age. Seeded from 042693a. */
export const GENERIC_PROMPT_V2 = `You are rewriting a real news story for a {{age}}-year-old child.

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

/** Pitched at a reading band ({{ageRange}}); no spoken version yet. Seeded from b58b572. */
export const GENERIC_PROMPT_V3 = `You are rewriting a real news story for children aged {{ageRange}}.

SOURCE: {{sourceName}}
CATEGORY: {{category}}
HEADLINE: {{headline}}

ARTICLE:
{{body}}

Rules:
- Stay true to the article. Never invent facts, numbers, names or quotes. If the article does not say something, leave it out.
- Write calmly. Do not sensationalise and do not frighten.
- Keep sentences short and use everyday words a {{age}}-year-old knows, so the youngest readers can follow it too.
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

// --- Young-readers override ---------------------------------------------------
//
// Keyed at '6' before reading bands existed, at '5' (the 5-7 band's anchor) since.

/** The age-6 override, keyed at '6'. Seeded from 6d2c455. */
export const YOUNG_READERS_PROMPT_V1 = `You are rewriting a real news story for a 6-year-old child who is just learning to read.

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
- "feelingNote" must be null when "safety" is "calm".
- "vocab" holds exactly two words that appear in the story, each explained in under 12 words.
- "readingMinutes" is a whole number, at least 1.`;

/** The age-6 override with explicit safety criteria, keyed at '6'. Seeded from 042693a. */
export const YOUNG_READERS_PROMPT_V2 = `You are rewriting a real news story for a 6-year-old child who is just learning to read.

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

/** The 5-7 band override, keyed at '5'; no spoken version yet. Seeded from b58b572. */
export const YOUNG_READERS_PROMPT_V3 = `You are rewriting a real news story for children aged 5 to 7 who are just learning to read.

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
- Prefer concrete things a 5-year-old can picture over abstract ideas.

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

/** V3 plus a spoken version ("audioScript"); no category choice yet. Seeded from 5efc3c1. */
export const GENERIC_PROMPT_V4 = `You are rewriting a real news story for children aged {{ageRange}}.

SOURCE: {{sourceName}}
CATEGORY: {{category}}
HEADLINE: {{headline}}

ARTICLE:
{{body}}

Rules:
- Stay true to the article. Never invent facts, numbers, names or quotes. If the article does not say something, leave it out.
- Write calmly. Do not sensationalise and do not frighten.
- Keep sentences short and use everyday words a {{age}}-year-old knows, so the youngest readers can follow it too.
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
  "audioScript": "The story told out loud for radio, for children aged {{ageRange}}. 60 to 90 words.",
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
- "audioScript" is the same story as a newsreader would say it out loud to
  children aged {{ageRange}}. Write it from the article, not from the summary
  you just wrote — it is a second telling of the news, not a reading of the
  first. Say what happened first. One idea per sentence. Never a clause a
  listener has to hold in their head while you finish. No headings, no bullet
  points, no stage directions, no "welcome back". 60 to 90 words.
- "readingMinutes" is a whole number, at least 1.`;

/** V3 plus a spoken version ("audioScript"); no category choice yet. Seeded from 5efc3c1. */
export const YOUNG_READERS_PROMPT_V4 = `You are rewriting a real news story for children aged 5 to 7 who are just learning to read.

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
- Prefer concrete things a 5-year-old can picture over abstract ideas.

Return ONLY a JSON object — no markdown fences, no commentary — in exactly this shape:

{
  "kidHeadline": "Short, warm, and easy to read out loud.",
  "summary": "One short sentence.",
  "whatHappened": "Two or three very short sentences.",
  "whyItMatters": "One or two very short sentences.",
  "vocab": [{ "word": "reef", "definition": "A long line of rock and coral under the sea." }],
  "thinkAbout": "One simple question a grown-up could ask at the dinner table.",
  "audioScript": "The story read out loud to a 5-year-old. 40 to 60 words.",
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
- "audioScript" is the same story as a kind grown-up would read it out loud to
  a 5-year-old. Write it from the article, not from the sentences you just
  wrote. Very short sentences, one idea each. Warm and calm. No headings, no
  bullet points, no stage directions. 40 to 60 words.
- "readingMinutes" is a whole number, at least 1.`;

/** Retired texts of the generic prompt, oldest first. */
export const RETIRED_GENERIC_PROMPTS: readonly string[] = [
  GENERIC_PROMPT_V1, GENERIC_PROMPT_V2, GENERIC_PROMPT_V3, GENERIC_PROMPT_V4,
];

/** Retired texts of the young-readers override, oldest first, whichever key they sat under. */
export const RETIRED_YOUNG_READERS_PROMPTS: readonly string[] = [
  YOUNG_READERS_PROMPT_V1, YOUNG_READERS_PROMPT_V2, YOUNG_READERS_PROMPT_V3, YOUNG_READERS_PROMPT_V4,
];
