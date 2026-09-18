/**
 * Turning a published story into audio a child can press play on (PRD §3.5).
 *
 * Written against the `SpeechProvider` contract and nothing else, so changing
 * provider never touches this file.
 */
import type { Database } from 'better-sqlite3';
import type { KidArticle } from '../core/article.js';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import { TTS_MAX_CHARS } from '../env.js';
import {
  audioFromBuffer, audioKey, type AudioCache, type CachedAudio,
} from '../tts/audioCache.js';
import { SPEECH_CONTENT_TYPES, type SpeechProvider } from '../tts/types.js';

/**
 * The script for a story published before `audioScript` existed.
 *
 * MIRRORS `segmentScript` in web/src/pages/Podcast.tsx, which shows this same
 * text on screen. §2.2 says a child hears exactly what is written, so the two
 * must stay identical — change one, change both.
 */
export function assembleScript(article: KidArticle): string {
  const word = article.vocab[0];
  return [
    `Our next story is from ${article.sourceName}. ${article.summary}`,
    word ? `Here's a fun word: "${word.word}" — ${word.definition}` : '',
    `Something to wonder about: ${article.thinkAbout}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** The words this story is spoken with: the reviewed script, or the fallback. */
export function scriptFor(article: KidArticle): string {
  const stored = article.audioScript?.trim();
  return stored ? stored : assembleScript(article);
}

export interface AudioSuccess {
  ok: true;
  /** Described, not loaded — the route streams it rather than buffering it. */
  body: CachedAudio;
  contentType: string;
  /** Doubles as the route's ETag. */
  key: string;
  cached: boolean;
}

export interface AudioFailure {
  ok: false;
  status: 404 | 503 | 502;
  reason: string;
}

export type AudioOutcome = AudioSuccess | AudioFailure;

export interface AudioService {
  forArticle(id: string, ageTarget: number): Promise<AudioOutcome>;
}

export interface AudioServiceOptions {
  /** Null means speech is switched off; every request then answers 503. */
  provider: SpeechProvider | null;
  cache: AudioCache;
  maxChars?: number;
}

export function createAudioService(db: Database, options: AudioServiceOptions): AudioService {
  const articles = createArticleRepository(db);
  const { provider, cache } = options;
  const maxChars = options.maxChars ?? TTS_MAX_CHARS;

  /**
   * Renderings being synthesised right now, so a crowd pays once. Without it,
   * five children pressing play on a new story in the same second are five
   * provider calls for identical audio.
   */
  const inFlight = new Map<string, Promise<AudioOutcome>>();

  const synthesise = async (key: string, script: string, id: string): Promise<AudioOutcome> => {
    const voice = provider!;
    const spoken = await voice.speak({ text: script });
    if (!spoken.ok) {
      // The reader only ever sees "could not be read aloud", so without this
      // line a wrong voice, an expired key and an outage are indistinguishable.
      console.error(
        `[tts] ${id} could not be spoken by ${voice.model}/${voice.voice}: ${spoken.reason}`,
      );
      // Not cached, so a blip does not become permanent.
      return { ok: false, status: 502, reason: spoken.reason };
    }

    await cache.write(key, spoken.audio);

    return {
      ok: true,
      body: audioFromBuffer(spoken.audio),
      contentType: spoken.contentType,
      key,
      cached: false,
    };
  };

  return {
    async forArticle(id, ageTarget) {
      if (!provider) {
        return { ok: false, status: 503, reason: 'Text-to-speech is not configured.' };
      }

      // Published only, hardcoded by the repository: this endpoint is
      // unauthenticated, and asking for a story to be read aloud must not be a
      // way around the review queue (§2.2).
      const article = articles.findPublishedForAge(id, ageTarget);
      if (!article) return { ok: false, status: 404, reason: 'No published story with that id.' };

      const script = scriptFor(article).slice(0, maxChars);
      if (!script.trim()) {
        return { ok: false, status: 404, reason: 'That story has nothing to say.' };
      }

      const key = audioKey({
        text: script,
        provider: provider.id,
        model: provider.model,
        voice: provider.voice,
        format: provider.format,
      });

      const hit = await cache.read(key);
      if (hit) {
        const contentType = SPEECH_CONTENT_TYPES[provider.format];
        return { ok: true, body: hit, contentType, key, cached: true };
      }

      // Join the synthesis already running for this rendering, or start one.
      // Cleared once settled, so a later request retries instead of replaying
      // an old failure.
      let pending = inFlight.get(key);
      if (!pending) {
        pending = synthesise(key, script, id).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }

      return pending;
    },
  };
}
