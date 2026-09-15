# A spoken version of every story — design

**Date:** 2026-09-15
**Status:** implemented
**Supersedes:** the "real text-to-speech" non-goal in PRD §2.2, and the
deferral in §13.2. Everything else in the PRD stands — §3.5's podcast page
keeps its placeholder player.

## 1. Problem

The podcast page shows one segment per published story, and each segment's
text is assembled in the browser by `segmentScript()` in `web/src/pages/Podcast.tsx`:

> Our next story is from BBC News. *{summary}* Here's a fun word: "awards" —
> *{definition}* Something to wonder about: *{thinkAbout}*

Three things are wrong with it.

**It is not writing.** It is three approved fields glued together with fixed
connectives. Read aloud it sounds like a form letter, because it is one.

**News for the ear is not news for the eye.** A listener cannot re-read a
clause they lost. Broadcast copy puts the "what" first, carries one idea per
sentence, and never asks anyone to hold a subordinate clause in their head.
The written story is shaped for a reader who can go back; reading it out is
the wrong shape.

**Nothing plays it.** The player is a placeholder with a fake progress bar and
a note saying to connect Lovable AI or ElevenLabs.

## 2. Decision

Every version of a story carries an **`audioScript`**: a short broadcast script
for that reading band, written by the model **in the call that already writes
the story**, stored on the row, reviewed with the story, and spoken in the
browser by the Web Speech API.

### Why not a second model call

A separate audio prompt was the obvious design and it was wrong twice over.

Fed the *finished kid story*, a second prompt can only paraphrase a paraphrase
— the compression has already happened, and the broadcast rewrite inherits the
shape it was supposed to escape. Fed the *raw article*, it works, but it
re-sends the whole body as input, doubling model spend one commit after
`2026-09-14-reading-bands-design.md` cut it by 70%, and it can re-derive a
story at a harsher safety level than the version an editor approved.

One call avoids all of it. The model is already holding the raw body and
already writing for a known band, so it renders the source twice in one pass —
once for the eye, once for the ear. The cost is output tokens only, roughly
150–250 words per version, not a second round trip carrying the article again.

The price is prompt coupling: one prompt now does two jobs, so a change aimed
at the spoken voice can regress the written story, and the sandbox diff shows
both moving together. That is accepted deliberately. It is the cheaper mistake.

### Why not TTS on the server

PRD §2.2 rules out text-to-speech and §13.2 defers it pending a Gemini Live or
ElevenLabs key. Both assume *server-side* synthesis: a credential, per-character
billing, audio files to store and serve. `SpeechSynthesis` is in the browser, so
there is no key, no bill, no file and no hosting. The reason for the non-goal is
gone, so the non-goal goes with it.

What the browser cannot do is record, export, download, or publish to a feed.
**This is read-aloud, not a podcast**, and the page's "Daily Episode" framing
outruns what it delivers. That is a copy question, not a blocker, and it is
left alone here.

### Why it is stored, not assembled

§2.2 promises a person reads every word a child sees. A script is words a child
*hears*, so it goes through the same gate: generated once, stored on the row,
visible in the diff, editable, and published with the story. Today's
`segmentScript()` is tolerable only because it recombines sentences an editor
already approved. Generated prose has no such excuse and must never be built
in the browser.

## 3. What changes

**Schema.** `kid_articles.audioScript TEXT`, nullable, via the `ADDED_COLUMNS`
pass in `src/db/init.ts`. `SCHEMA_VERSION` 5 → 6. Additive, so no table
rebuild. Nullable carries three meanings at once, and all three matter: the row
predates this feature, the model omitted the field, or the rule-based fallback
wrote the version.

**Parsing.** `LlmContent` gains `audioScript: string | null`. It does **not**
join `REQUIRED_TEXT`. It follows `feelingNote` exactly — a non-empty string is
trimmed and kept, anything else becomes `null`:

```ts
const audioScript =
  typeof raw.audioScript === 'string' && raw.audioScript.trim()
    ? raw.audioScript.trim()
    : null;
```

This is the single most important line in the design. `parseLlmContent` throws
`LlmResponseError` on a bad required field, and `simplifyArticle` catches that
and drops the **whole version** to the rule-based pipeline. If a malformed
script could fail the parse, a bad audio field would cost the story. The parser
already states the principle for vocab — "a missing word list is a much smaller
loss than a lost story" — and a missing script is smaller still.

**Prompts.** Both seeded prompts gain a broadcast-script section and the
`audioScript` key in their JSON envelope. Both, not one: §9.1 says an override
*replaces* the generic prompt rather than extending it, so
`YOUNG_READERS_SIMPLIFICATION_PROMPT` is a complete standalone prompt. Teaching
only the generic prompt would leave **ages 5–7 as the one band with no audio** —
the youngest children, who need read-aloud most, and exactly backwards from the
intent. A test asserts every seeded simplification prompt asks for the field,
so a future prompt cannot quietly drop it.

**Per band.** Nothing to build. The call is already once per band, so each
band's call writes its own script at its own reading level, and the podcast page
already fetches the reader's band version.

**Review surfaces.** `audioScript` joins `DIFF_FIELDS` in
`web/src/pages/admin/dialogs/VersionDiff.tsx`, so a regeneration shows it and
applies it with the tick, and in `web/src/pages/admin/sandbox/ResultsPanel.tsx`,
so it is tunable where prompts are tuned. `EditDialog` gains a textarea;
editing sets `editedByHuman`, which is already per-version. `PATCH /articles/:id`
accepts it. Publish, reject, unpublish and delete need no change — they are
story-scoped and move the whole row.

**Speech.** A new `web/src/lib/useSpeech.ts`:

- Splits the script into sentences and queues **one utterance per sentence**.
  Chrome silently truncates a single utterance after roughly 15 seconds, so a
  whole story spoken as one utterance cuts off mid-word.
- Drives highlighting from the **chunk index**, not `onboundary`. Word-level
  boundary events are reliable only in Chrome and Edge; sentence boundaries are
  ours, so they work everywhere.
- Uses the device's default voice — no `voiceschanged` listener and no
  `getVoices()` call, because the hook never selects a voice — and cancels on
  unmount so speech does not outlive the page.
- Reports `supported: boolean` when `speechSynthesis` is absent, and the button
  is not rendered rather than rendered dead.

Playback needs a user gesture, so there is no autoplay. Voice quality is the
device's, not ours: good on iOS and macOS, acceptable on Windows, often robotic
on Linux Chrome. Nothing in our control changes that.

**Podcast page.** Each segment renders its stored `audioScript` with a play
button, highlighting the sentence being spoken. When `audioScript` is `null`,
the segment falls back to today's `segmentScript()` output and is still
playable. The rule is **play what is displayed**.

The fallback is what lets this ship without a regeneration run: every story
published before this change has `audioScript = null`, and without it the page
would go blank for all of them. It decays on its own as stories turn over.

## 4. Not changed

- **The placeholder player.** The big play button, its progress bar and its
  "connect text-to-speech" note stay as they are. Real episode audio is a later
  improvement and the placeholder is its integration point, per §3.5.
- **The intro and closing copy.** Static page text, not story content, and
  nothing generates them.
- **Model call count.** Still three per story plus the shared §6.2 guard.
- **Auto-approve.** A missing script is not a pipeline fallback and never
  enters `outcome.fallbacks`, so it cannot hold a story from publishing. A
  version with no script publishes normally and shows no play button.
- **The public API shape**, apart from the new field. Only published versions
  are served, so a script reaches a child only after approval.

## 5. Testing

**Server.** 619 tests passing. The parser keeps a well-formed script, nulls an
empty or non-string one, and — the case that matters — still parses an article
whose `audioScript` is malformed, without falling back. Both seeded prompts
request the field. A generated version round-trips the script through insert
and read. `PATCH` accepts an edited script and sets `editedByHuman`. Regenerate
carries it into the preview and writes it on apply. The rule-based fallback
yields `null`.

**Web.** 281 tests passing. `useSpeech` against a mocked `speechSynthesis` —
jsdom has none — sentences are queued one utterance at a time, the highlight
advances with the chunk, cancel stops playback, unmount cancels, and
`unsupported` renders no button. The podcast page shows a stored script when
present, falls back to the assembled one when `null`, and plays what it
displays.

## 6. Work

Six commits, each green on its own:

1. store an audio script on every version — column, types, repository, public
   API, optional parsing
2. ask the seeded prompts for a spoken version of the story — both prompts,
   sandbox result panel
3. carry the audio script through regenerate and edit
4. speak a story with the browser's own voice — `useSpeech`
5. play each story on the podcast page
6. docs

## 7. Open question

Not blocking, and one for the product owner rather than the code: if "podcast"
is meant to be something a parent downloads and plays in the car with no
signal, none of this delivers it, and the server-side TTS §13.2 already prices
is the only thing that does. This design assumes read-aloud in an open tab.
