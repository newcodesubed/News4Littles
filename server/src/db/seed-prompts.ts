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
 * {{sourceName}}, {{age}}, {{ageRange}}.
 *
 * A story is written once per reading BAND (AGE_BANDS: 5-7, 8-10, 11-14), so
 * {{age}} is the band's youngest age and {{ageRange}} the whole band. The
 * generic prompt frames the story for the band and pitches vocabulary at its
 * youngest reader, which is the safe direction for a children's product.
 *
 * NOTE: an override REPLACES the generic prompt rather than extending it
 * (§9.1: "age-specific override if it exists, else generic"), so each override
 * must be a complete, standalone prompt. Overrides are keyed by the band's
 * youngest age.
 *
 * The safety criteria below are deliberately explicit. With only the three-line
 * description they replaced, a real model rated a story about four people killed
 * and eleven wounded as "calm" — 2 of 5 test articles classified correctly. With
 * these criteria it was 5 of 5, in the same single call.
 */

export const GENERIC_SIMPLIFICATION_PROMPT = `You are rewriting a real news story for children aged {{ageRange}}.

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
  "category": "One category from the list in the field notes.",
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
- "category" must be exactly one of "World", "Science", "Environment",
  "Health", "Culture", "Technology", "Sports" or "Good News" — whichever best
  fits what the story is about. The CATEGORY above is only a first guess from
  keywords; replace it when it is wrong. "Good News" is for a story whose main
  point is something kind, brave or hopeful. "World" is for news that fits
  none of the others.
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

/** The 5-7 band: children who are just learning to read. Keyed by '5'. */
export const YOUNG_READERS_SIMPLIFICATION_PROMPT = `You are rewriting a real news story for children aged 5 to 7 who are just learning to read.

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
  "category": "One category from the list in the field notes.",
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
- "category" must be exactly one of "World", "Science", "Environment",
  "Health", "Culture", "Technology", "Sports" or "Good News" — whichever best
  fits what the story is about. The CATEGORY above is only a first guess from
  keywords; replace it when it is wrong. "Good News" is for a story whose main
  point is something kind, brave or hopeful. "World" is for news that fits
  none of the others.
- "vocab" holds exactly two words that appear in the story, each explained in
  under 12 words. Never proper nouns, brand names or people's names.
- "audioScript" is the same story as a kind grown-up would read it out loud to
  a 5-year-old. Write it from the article, not from the sentences you just
  wrote. Very short sentences, one idea each. Warm and calm. No headings, no
  bullet points, no stage directions. 40 to 60 words.
- "readingMinutes" is a whole number, at least 1.`;
