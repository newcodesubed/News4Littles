/**
 * Live check of the text-to-speech path — PRD §3.5.
 *
 *   npm run tts:check
 *
 * Deliberately standalone and NOT part of `npm test`, because it calls a paid
 * API. Writes an .mp3 you can actually listen to, and nothing to the database.
 *
 * Use it after changing TTS_PROVIDER, TTS_MODEL or TTS_VOICE: a wrong voice id
 * for the chosen model is the most common misconfiguration, and it shows up
 * here as a 400 from the provider rather than as a silent play button.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import {
  OPENROUTER_KEY, SERVER_ROOT, TTS_ENABLED, TTS_MODEL, TTS_PROVIDER, TTS_VOICE,
} from '../src/env.js';
import { createSpeechProvider } from '../src/tts/index.js';
import { scriptFor } from '../src/services/audioService.js';
import { createArticleRepository } from '../src/db/repositories/articleRepository.js';

const RULE = '─'.repeat(78);

async function usage(): Promise<number> {
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
  });
  if (!res.ok) return Number.NaN;
  return Number(((await res.json()) as { data: { usage: number } }).data.usage);
}

async function main(): Promise<void> {
  console.log(`provider     ${TTS_PROVIDER}`);
  console.log(`model        ${TTS_MODEL}`);
  console.log(`voice        ${TTS_VOICE}`);
  console.log(`TTS enabled  ${TTS_ENABLED}`);

  const provider = createSpeechProvider();
  if (!provider) {
    console.log('\nTTS is switched off (TTS_ENABLED=false), so no story is read aloud.');
    return;
  }

  const db = openDatabase();

  try {
    // A real published story if there is one, so the check exercises the same
    // script resolution the route does.
    const published = createArticleRepository(db).listPublishedForAge(8);
    const script = published[0]
      ? scriptFor(published[0])
      : 'Hello friends! Welcome back to News for Curious Kids. Today we have one short story.';

    console.log(`\n${RULE}`);
    console.log(published[0] ? `STORY     ${published[0].kidHeadline}` : 'STORY     (none published; using a sample line)');
    console.log(`SCRIPT    ${script.slice(0, 160)}${script.length > 160 ? '…' : ''}`);
    console.log(RULE);

    const result = await provider.speak({ text: script });

    if (!result.ok) {
      console.log(`\nFAILED    ${result.reason}`);
      console.log(result.transient ? '          (transient — worth retrying)' : '          (permanent — check TTS_MODEL / TTS_VOICE)');
      process.exitCode = 1;
      return;
    }

    const out = resolve(SERVER_ROOT, `tts-check.${result.format}`);
    writeFileSync(out, result.audio);

    console.log(`\nOK        ${result.model} · ${result.voice}`);
    console.log(`          ${(result.audio.byteLength / 1024).toFixed(1)} KB of ${result.contentType} in ${result.elapsedMs}ms`);
    console.log(`          written to ${out} — play it.`);
    console.log(`\nKey total so far: $${(await usage()).toFixed(5)}  (lags by a few seconds)`);
    console.log('Nothing was written to the database or to the audio cache.');
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error('Check failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
