/**
 * Synthesised audio, kept so a story is paid for once rather than once per
 * listener.
 *
 * Content-addressed: the key is a hash of everything that could change the
 * sound — the text, the provider, the model, the voice and the format. That
 * gives invalidation for free. An editor rewriting an audio script, or a new
 * TTS_VOICE in .env, simply produces a different key, so nobody has to
 * remember to clear anything and no child is served last week's wording in
 * last month's voice.
 *
 * Files, not a database column: audio is hundreds of kilobytes per story and
 * SQLite is on the request path for everything else here. Files also mean the
 * cache can be thrown away with `rm -rf data/audio` at any time.
 *
 * Deliberately knows nothing about articles or providers — it stores bytes
 * under a key. The article-shaped logic lives in ../services/audioService.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeechFormat } from './types.js';

/** Everything that changes the sound, and nothing that does not. */
export interface AudioKeyParts {
  text: string;
  provider: string;
  model: string;
  voice: string;
  format: SpeechFormat;
}

/**
 * The cache filename for one rendering. Newline-joined with the field order
 * fixed, so two different sets of parts cannot collide by concatenation.
 */
export function audioKey(parts: AudioKeyParts): string {
  const digest = createHash('sha256')
    .update([parts.provider, parts.model, parts.voice, parts.format, parts.text].join('\n'))
    .digest('hex');

  return `${digest}.${parts.format}`;
}

export interface AudioCache {
  /** The stored bytes, or undefined if this rendering has never been made. */
  read(key: string): Buffer | undefined;
  write(key: string, audio: Buffer): void;
}

export function createFileAudioCache(directory: string): AudioCache {
  mkdirSync(directory, { recursive: true });

  return {
    read(key) {
      try {
        return readFileSync(join(directory, key));
      } catch {
        // Missing is the normal case; unreadable is a cache miss too, because
        // re-synthesising costs money but serving half a file costs trust.
        return undefined;
      }
    },

    write(key, audio) {
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that every later request happily serves as a complete story.
      const final = join(directory, key);
      const temporary = `${final}.${process.pid}.tmp`;
      writeFileSync(temporary, audio);
      renameSync(temporary, final);
    },
  };
}

/** For tests: the same contract, held in memory, nothing on disk. */
export function createMemoryAudioCache(): AudioCache {
  const files = new Map<string, Buffer>();
  return {
    read: (key) => files.get(key),
    write: (key, audio) => void files.set(key, audio),
  };
}
