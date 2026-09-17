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
 * A read hands back a SIZE AND A WAY TO OPEN THE BYTES, never the bytes
 * themselves. Half a megabyte per listener held in memory, read with a
 * synchronous call that stops the event loop for everyone else, is the wrong
 * shape for a file this size — so the route streams it instead.
 *
 * Deliberately knows nothing about articles or providers — it stores bytes
 * under a key. The article-shaped logic lives in ../services/audioService.ts.
 */
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
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

/** Stored audio, described but not yet loaded. */
export interface CachedAudio {
  /** Byte length, for Content-Length — known without reading the file. */
  size: number;
  /** A fresh stream over the bytes. Called once per response. */
  open(): Readable;
}

export interface AudioCache {
  /** Undefined if this rendering has never been made. */
  read(key: string): Promise<CachedAudio | undefined>;
  write(key: string, audio: Buffer): Promise<void>;
}

export function createFileAudioCache(directory: string): AudioCache {
  mkdirSync(directory, { recursive: true });

  return {
    async read(key) {
      const path = join(directory, key);
      try {
        // stat, not readFile: a hit costs one metadata call, and the bytes are
        // only ever touched as they flow to the socket.
        const { size } = await stat(path);
        return { size, open: () => createReadStream(path) };
      } catch {
        // Missing is the normal case; unreadable is a cache miss too, because
        // re-synthesising costs money but serving half a file costs trust.
        return undefined;
      }
    },

    async write(key, audio) {
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that every later request happily serves as a complete story.
      const final = join(directory, key);
      const temporary = `${final}.${process.pid}.tmp`;
      await writeFile(temporary, audio);
      await rename(temporary, final);
    },
  };
}

/** For tests, and for the case where nothing will ever be written. */
export function createMemoryAudioCache(): AudioCache {
  const files = new Map<string, Buffer>();
  return {
    async read(key) {
      const audio = files.get(key);
      return audio && { size: audio.byteLength, open: () => Readable.from([audio]) };
    },
    async write(key, audio) {
      files.set(key, audio);
    },
  };
}

/** Audio already in hand, in the same shape a cache read returns. */
export function audioFromBuffer(audio: Buffer): CachedAudio {
  return { size: audio.byteLength, open: () => Readable.from([audio]) };
}
