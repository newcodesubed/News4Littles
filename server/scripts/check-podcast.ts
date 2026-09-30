import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bandForAge } from '../src/core/article.js';
import { openDatabase } from '../src/db/connection.js';
import { LLM_ENABLED, LLM_MODEL, SERVER_ROOT } from '../src/env.js';
import { createEpisodeService, createPodcastLlm } from '../src/services/episodeService.js';
import { createMemoryAudioCache } from '../src/tts/audioCache.js';
import { createSpeechProvider } from '../src/tts/index.js';

const RULE = '─'.repeat(78);

function readAge(): number {
  const at = process.argv.indexOf('--age');
  const age = at > -1 ? Number(process.argv[at + 1]) : 8;
  return bandForAge(Number.isInteger(age) ? age : 8).minAge;
}

async function main(): Promise<void> {
  const ageTarget = readAge();
  const provider = createSpeechProvider();
  const db = openDatabase();

  try {
    const service = createEpisodeService(db, {
      llm: createPodcastLlm(),
      provider,
      cache: createMemoryAudioCache(),
    });

    console.log(`band         ageTarget ${ageTarget}`);
    console.log(`LLM          ${LLM_ENABLED ? LLM_MODEL : 'off — the stitched fallback will play'}`);
    console.log(`voice        ${provider ? `${provider.model} · ${provider.voice}` : 'off (TTS_ENABLED=false)'}`);

    let started = Date.now();
    const episode = await service.episodeFor(ageTarget);
    if (!episode.date) {
      console.log('\nNothing is published for this band, so there is no episode.');
      return;
    }

    const row = db
      .prepare(`SELECT source, reason, model, costUsd FROM podcast_episodes
                WHERE ageTarget = ? ORDER BY updatedAt DESC LIMIT 1`)
      .get(ageTarget) as { source: string; reason: string | null; model: string | null; costUsd: number | null };

    console.log(`\n${RULE}`);
    console.log(`DAY       ${episode.date} · ${episode.articles.length} stories`);
    console.log(`SOURCE    ${row.source}${row.reason ? ` — ${row.reason}` : ''}`);
    console.log(`SCRIPT    ${episode.script!.length} characters in ${Date.now() - started}ms` +
      (row.costUsd ? ` · $${row.costUsd.toFixed(5)}` : ''));
    console.log(RULE);
    console.log(episode.script);
    console.log(RULE);

    if (!episode.audioKey) {
      console.log('\nTTS is switched off, so the episode was not spoken.');
      return;
    }

    started = Date.now();
    const audio = await service.audioFor(ageTarget, episode.audioKey);
    if (!audio.ok) {
      console.log(`\nFAILED    ${audio.status} ${audio.reason}`);
      process.exitCode = 1;
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of audio.body.open()) chunks.push(chunk as Buffer);
    const out = resolve(SERVER_ROOT, 'podcast-check.mp3');
    writeFileSync(out, Buffer.concat(chunks));

    console.log(`\nOK        ${(audio.body.size / 1024).toFixed(1)} KB in ${Date.now() - started}ms`);
    console.log(`          written to ${out} — listen for clicks between sentences.`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
