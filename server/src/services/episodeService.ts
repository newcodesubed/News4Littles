/**
 * The daily podcast episode: the latest day's stories, retold by the LLM as one
 * script and spoken as one file.
 *
 * Built on demand and remembered under an episode key hashed from everything
 * that shapes the script. So a reload is a lookup, and a newly published or
 * edited story is a new key and a new episode — nothing is ever invalidated by
 * hand. See docs/superpowers/specs/2026-09-28-daily-podcast-episode-design.md.
 *
 * Nobody reviews the script, so safety is layered: reviewed inputs, a strict
 * prompt, free checks on the answer, and a stitched fallback built only from
 * reviewed text whenever any of that fails.
 */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { bandForAge, type KidArticle } from '../core/article.js';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import {
  createEpisodeRepository, type EpisodeSource, type StoredEpisode,
} from '../db/repositories/episodeRepository.js';
import {
  LLM_MODEL, PODCAST_MAX_CHARS, PODCAST_MAX_STORIES, SCRAPE_TIMEZONE, TTS_MAX_CHARS,
} from '../env.js';
import type { OpenRouterClient } from '../llm/openRouterClient.js';
import { logger, type Logger } from '../logger.js';
import { detectInjection } from '../pipeline/approvalGuard.js';
import { chunkScript } from '../podcast/chunkScript.js';
import {
  EPISODE_PROMPT_VERSION, checkEpisodeScript, parseEpisodeScript, renderEpisodePrompt,
  toEpisodeStory, type EpisodeStory,
} from '../podcast/episodePrompt.js';
import { buildFallbackEpisode } from '../podcast/fallbackEpisode.js';
import { joinMp3 } from '../podcast/joinMp3.js';
import { audioFromBuffer, audioKey, type AudioCache } from '../tts/audioCache.js';
import { SPEECH_CONTENT_TYPES, type SpeechProvider } from '../tts/types.js';
import type { AudioSuccess } from './audioService.js';

/** What GET /api/podcast answers. */
export interface EpisodeView {
  /** Local YYYY-MM-DD the stories were published; null when there are none. */
  date: string | null;
  articles: KidArticle[];
  script: string | null;
  source: EpisodeSource | null;
  /** The content hash of the script's audio; null with no voice or no episode. */
  audioKey: string | null;
}

export interface EpisodeAudioFailure {
  ok: false;
  status: 404 | 409 | 502 | 503;
  reason: string;
}

export type EpisodeAudioOutcome = AudioSuccess | EpisodeAudioFailure;

export interface EpisodeService {
  episodeFor(ageTarget: number): Promise<EpisodeView>;
  /** Never writes a script: only the current episode's audio can be spoken. */
  audioFor(ageTarget: number, audioKey: string): Promise<EpisodeAudioOutcome>;
}

export interface EpisodeServiceOptions {
  /** Null means the LLM is off, and every episode is the stitched fallback. */
  llm: Pick<OpenRouterClient, 'complete'> | null;
  /** Part of the key, so a new LLM_MODEL writes new episodes. */
  llmModel?: string;
  /** Null means speech is off: episodes have no audioKey, and audio is 503. */
  provider: SpeechProvider | null;
  cache: AudioCache;
  timeZone?: string;
  maxStories?: number;
  maxChars?: number;
  /** Longest piece sent to the voice in one request. */
  chunkChars?: number;
  /** How long a temporary fallback stands before the model is tried again. */
  retryAfterMs?: number;
  now?: () => Date;
  logger?: Logger;
}

const EMPTY: EpisodeView = { date: null, articles: [], script: null, source: null, audioKey: null };

const TEN_MINUTES = 10 * 60 * 1000;

/** Room for about a thousand words of script plus the JSON around them. */
const EPISODE_MAX_TOKENS = 3_000;

/** Everything that shapes the script, and nothing that does not. */
export function episodeKey(parts: {
  version: number;
  model: string;
  ageTarget: number;
  date: string;
  stories: EpisodeStory[];
}): string {
  return createHash('sha256')
    .update(
      [
        String(parts.version),
        parts.model,
        String(parts.ageTarget),
        parts.date,
        ...parts.stories.map((s) => [s.id, s.kidHeadline, s.sourceName, s.script, s.thinkAbout].join('\n')),
      ].join('\n\n'),
    )
    .digest('hex');
}

type Composed = Pick<StoredEpisode, 'script' | 'source' | 'reason' | 'model' | 'costUsd' | 'retryAfter'>;

export function createEpisodeService(db: Database, options: EpisodeServiceOptions): EpisodeService {
  const articles = createArticleRepository(db);
  const episodes = createEpisodeRepository(db);
  const { llm, provider, cache } = options;
  const llmModel = options.llmModel ?? LLM_MODEL;
  const timeZone = options.timeZone ?? SCRAPE_TIMEZONE;
  const maxStories = options.maxStories ?? PODCAST_MAX_STORIES;
  const maxChars = options.maxChars ?? PODCAST_MAX_CHARS;
  const chunkChars = options.chunkChars ?? TTS_MAX_CHARS;
  const retryAfterMs = options.retryAfterMs ?? TEN_MINUTES;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? logger.child({ area: 'podcast' });

  /** Scripts and audio being made right now, so a crowd pays once. */
  const writing = new Map<string, Promise<StoredEpisode>>();
  const speaking = new Map<string, Promise<EpisodeAudioOutcome>>();

  /** The day's stories and the key they hash to. Reads only. */
  const inputsFor = (ageTarget: number) => {
    const day = articles.listLatestPublishedDayForAge(ageTarget, timeZone, maxStories);
    if (!day.date || day.articles.length === 0) return null;

    const stories = day.articles.map(toEpisodeStory);
    const key = episodeKey({
      version: EPISODE_PROMPT_VERSION,
      // Switching the LLM on turns yesterday's permanent fallback into a new key.
      model: llm ? llmModel : 'fallback',
      ageTarget,
      date: day.date,
      stories,
    });
    return { ageTarget, date: day.date, articles: day.articles, stories, key };
  };
  type Inputs = NonNullable<ReturnType<typeof inputsFor>>;

  const audioKeyFor = (script: string): string | null =>
    provider
      ? audioKey({
          text: script, provider: provider.id, model: provider.model,
          voice: provider.voice, format: provider.format,
        })
      : null;

  /** A stored episode stands unless it is a temporary fallback past its time. */
  const stillStands = (episode: StoredEpisode): boolean =>
    !episode.retryAfter || Date.parse(episode.retryAfter) > now().getTime();

  const fallback = (inputs: Inputs, reason: string, temporary: boolean): Composed => ({
    script: buildFallbackEpisode(inputs.stories),
    source: 'fallback',
    reason,
    model: null,
    costUsd: null,
    retryAfter: temporary ? new Date(now().getTime() + retryAfterMs).toISOString() : null,
  });

  const compose = async (inputs: Inputs): Promise<Composed> => {
    if (!llm) return fallback(inputs, 'The LLM is switched off.', false);

    // Checked before the call: a story trying to steer the model is spoken
    // through the fallback, and the model never has to resist it.
    for (const story of inputs.stories) {
      for (const field of [story.kidHeadline, story.sourceName, story.script, story.thinkAbout]) {
        const tripped = detectInjection(field);
        if (tripped) return fallback(inputs, `A story's text reads as an instruction (${tripped}).`, false);
      }
    }

    const result = await llm.complete({
      prompt: renderEpisodePrompt(inputs.stories, bandForAge(inputs.ageTarget), maxChars),
      maxTokens: EPISODE_MAX_TOKENS,
    });
    // Only a transient failure (timeout, 429, 5xx) is worth trying again later.
    if (!result.ok) return fallback(inputs, `The LLM failed: ${result.reason}`, result.transient);

    const costUsd = result.costUsd ?? null;
    const script = parseEpisodeScript(result.text);
    if (!script) {
      return { ...fallback(inputs, 'The LLM did not answer with {"script": "..."}.', false), costUsd };
    }

    const check = checkEpisodeScript(script, inputs.stories, maxChars);
    if (!check.ok) return { ...fallback(inputs, check.reason, false), costUsd };

    return { script, source: 'llm', reason: null, model: result.model, costUsd, retryAfter: null };
  };

  const write = async (inputs: Inputs, previous: StoredEpisode | undefined): Promise<StoredEpisode> => {
    const composed = await compose(inputs);
    const at = now().toISOString();
    const episode: StoredEpisode = {
      key: inputs.key,
      ageTarget: inputs.ageTarget,
      date: inputs.date,
      articleIds: inputs.articles.map((article) => article.id),
      ...composed,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    episodes.upsert(episode);

    const fields = { key: episode.key, ageTarget: episode.ageTarget, date: episode.date };
    if (episode.source === 'fallback') {
      // The page looks the same either way, so without this line a dead model
      // and a failed check are invisible.
      log.warn({ ...fields, reason: episode.reason, retryAfter: episode.retryAfter }, 'podcast episode used the fallback');
    } else {
      log.info({ ...fields, model: episode.model, costUsd: episode.costUsd }, 'podcast episode written');
    }
    return episode;
  };

  const view = (inputs: Inputs, episode: StoredEpisode): EpisodeView => ({
    date: inputs.date,
    articles: inputs.articles,
    script: episode.script,
    source: episode.source,
    audioKey: audioKeyFor(episode.script),
  });

  const speak = async (key: string, script: string): Promise<EpisodeAudioOutcome> => {
    const voice = provider!;
    const chunks = chunkScript(script, chunkChars);
    const audio: Buffer[] = new Array<Buffer>(chunks.length);
    // An object, not a `let`: TypeScript does not see assignments made inside
    // the workers, and would narrow a plain variable to null below.
    const state: { failure: string | null; next: number } = { failure: null, next: 0 };

    // Two at a time: faster than one for the first listener, gentler on the
    // provider's rate limit than all at once. A failure stops both workers.
    const worker = async () => {
      while (state.failure === null && state.next < chunks.length) {
        const index = state.next++;
        const spoken = await voice.speak({ text: chunks[index]! });
        if (!spoken.ok) {
          state.failure ??= spoken.reason;
          return;
        }
        audio[index] = spoken.audio;
      }
    };
    await Promise.all([worker(), worker()]);

    if (state.failure !== null) {
      log.error(
        { key, model: voice.model, voice: voice.voice, reason: state.failure },
        'podcast episode could not be spoken',
      );
      // Not cached: half an episode is never served, and a blip is not permanent.
      return { ok: false, status: 502, reason: state.failure };
    }

    // MP3 is a run of self-contained frames, so pieces in the same voice and
    // format play straight through when joined — once each piece's own length
    // header is gone (see joinMp3).
    const joined = voice.format === 'mp3' ? joinMp3(audio) : Buffer.concat(audio);
    await cache.write(key, joined);
    return {
      ok: true, body: audioFromBuffer(joined), contentType: SPEECH_CONTENT_TYPES[voice.format],
      key, cached: false,
    };
  };

  return {
    async episodeFor(ageTarget) {
      const inputs = inputsFor(ageTarget);
      if (!inputs) return EMPTY;

      const stored = episodes.findByKey(inputs.key);
      if (stored && stillStands(stored)) return view(inputs, stored);

      // Join the write already running for this key, or start one. Cleared
      // once settled, so the next request after a temporary fallback retries.
      let pending = writing.get(inputs.key);
      if (!pending) {
        pending = write(inputs, stored).finally(() => writing.delete(inputs.key));
        writing.set(inputs.key, pending);
      }
      return view(inputs, await pending);
    },

    async audioFor(ageTarget, requested) {
      if (!provider) return { ok: false, status: 503, reason: 'Text-to-speech is not configured.' };

      const inputs = inputsFor(ageTarget);
      if (!inputs) return { ok: false, status: 404, reason: 'There is no episode yet.' };

      // Only the episode a page was shown, and only while it is still the
      // current one: a story unpublished since must never be read out.
      const stored = episodes.findByKey(inputs.key);
      if (!stored || audioKeyFor(stored.script) !== requested) {
        return { ok: false, status: 409, reason: 'The episode has changed. Fetch it again.' };
      }

      const hit = await cache.read(requested);
      if (hit) {
        return { ok: true, body: hit, contentType: SPEECH_CONTENT_TYPES[provider.format], key: requested, cached: true };
      }

      let pending = speaking.get(requested);
      if (!pending) {
        pending = speak(requested, stored.script).finally(() => speaking.delete(requested));
        speaking.set(requested, pending);
      }
      return pending;
    },
  };
}
