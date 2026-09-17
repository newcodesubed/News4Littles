/**
 * Synthesised audio, kept so a story is paid for once rather than once per
 * listener.
 *
 * Content-addressed: the key hashes everything that could change the sound, so
 * invalidation is free — an edited script or a new TTS_VOICE simply produces a
 * different key, and nobody has to remember to clear anything.
 *
 * A read hands back a size and a way to OPEN the bytes, never the bytes: half a
 * megabyte per listener in memory is the wrong shape for a file this size.
 *
 * Safe to delete the whole directory at any time.
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

/** Newline-joined so two different sets of parts cannot collide. */
export function audioKey(parts: AudioKeyParts): string {
  const digest = createHash('sha256')
    .update([parts.provider, parts.model, parts.voice, parts.format, parts.text].join('\n'))
    .digest('hex');

  return `${digest}.${parts.format}`;
}

/** Stored audio, described but not yet loaded. */
export interface CachedAudio {
  size: number;
  /** A fresh stream over the bytes, one per response. */
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
        // only touched as they flow to the socket.
        const { size } = await stat(path);
        return { size, open: () => createReadStream(path) };
      } catch {
        // Unreadable counts as a miss too: re-synthesising costs money, but
        // serving half a file costs trust.
        return undefined;
      }
    },

    async write(key, audio) {
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that every later request serves as a complete story.
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
