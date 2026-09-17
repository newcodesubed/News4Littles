/**
 * Turning a published story into audio a child can press play on (PRD §3.5).
 *
 * This is the business logic, and it is written against the `SpeechProvider`
 * contract in ../tts/types.ts and nothing else. It does not import OpenRouter,
 * does not know what a voice id looks like and holds no key. That is the point:
 * changing provider must not touch this file.
 *
 * What it does own:
 *   * which stories may be spoken at all (published only, §2.2),
 *   * which words are spoken (the reviewed script, §2.2 again),
 *   * how often the bill is paid (once per distinct rendering, via the cache).
 */
import type { Database } from 'better-sqlite3';
import type { KidArticle } from '../core/article.js';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import { TTS_MAX_CHARS } from '../env.js';
import { audioKey, type AudioCache } from '../tts/audioCache.js';
import { SPEECH_CONTENT_TYPES, type SpeechProvider } from '../tts/types.js';

/**
 * The script for a story published before `audioScript` existed.
 *
 * MIRRORS `segmentScript` in web/src/pages/Podcast.tsx, which renders the same
 * text on screen — the rule in §2.2 is that a child hears exactly what is
 * written, so these two must stay identical. They are duplicated rather than
 * shared because the web mirrors the server's types by hand everywhere else
 * (see web/src/lib/types.ts); a test pins the wording on this side.
 *
 * It only ever recombines sentences an editor already approved. It never
 * writes new ones.
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
  audio: Buffer;
  contentType: string;
  /** The cache key, which the route reuses as a strong ETag. */
  key: string;
  /** False when this request is the one that paid for the synthesis. */
  cached: boolean;
}

export interface AudioFailure {
  ok: false;
  /** What the route should answer with. */
  status: 404 | 503 | 502;
  reason: string;
}

export type AudioOutcome = AudioSuccess | AudioFailure;

export interface AudioService {
  /** Audio for one published story, at one reading age. */
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

  return {
    async forArticle(id, ageTarget) {
      if (!provider) {
        return { ok: false, status: 503, reason: 'Text-to-speech is not configured.' };
      }

      // Published only, and the repository hardcodes that — this endpoint is
      // unauthenticated, exactly like GET /api/articles/:id, and a story still
      // in the review queue must not be readable by asking it to be read aloud.
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

      const hit = cache.read(key);
      if (hit) {
        // A hit has no provider response to read the content type off, so it
        // comes from the same format the key was built from.
        const contentType = SPEECH_CONTENT_TYPES[provider.format];
        return { ok: true, audio: hit, contentType, key, cached: true };
      }

      const spoken = await provider.speak({ text: script });
      if (!spoken.ok) {
        // A provider failure is a story without audio, never a broken page.
        return { ok: false, status: 502, reason: spoken.reason };
      }

      cache.write(key, spoken.audio);

      return { ok: true, audio: spoken.audio, contentType: spoken.contentType, key, cached: false };
    },
  };
}
