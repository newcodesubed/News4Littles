import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { bandForAge, type KidArticle } from '../core/article.js';
import { createArticleRepository } from '../db/repositories/articleRepository.js';
import {
  createEpisodeRepository, type EpisodeSource, type StoredEpisode,
} from '../db/repositories/episodeRepository.js';
import {
  LLM_ENABLED, LLM_MODEL, PODCAST_LLM_MAX_RETRIES, PODCAST_LLM_MAX_TOKENS, PODCAST_LLM_TIMEOUT_MS,
  PODCAST_MAX_ATTEMPTS, PODCAST_MAX_CHARS, PODCAST_MAX_STORIES, SCRAPE_TIMEZONE, TTS_MAX_CHARS,
} from '../env.js';
import { OpenRouterClient } from '../llm/openRouterClient.js';
import { logger, type Logger } from '../logger.js';
import { detectInjection } from '../pipeline/approvalGuard.js';
import { chunkScript } from '../podcast/chunkScript.js';
import {
  EPISODE_PROMPT_VERSION, checkEpisodeScript, parseEpisodeScript, renderEpisodePrompt,
  storyTexts, toEpisodeStory, type EpisodeStory,
} from '../podcast/episodePrompt.js';
import { buildFallbackEpisode } from '../podcast/fallbackEpisode.js';
import { joinMp3 } from '../podcast/joinMp3.js';
import { audioFromBuffer, audioKey, type AudioCache } from '../tts/audioCache.js';
import { SPEECH_CONTENT_TYPES, type SpeechProvider } from '../tts/types.js';
import type { AudioSuccess } from './audioService.js';

/** The day's stories alone: a database read, so a page can show them before the episode is written. */
export interface EpisodeDay {
  date: string | null;
  articles: KidArticle[];
}

export interface EpisodeView extends EpisodeDay {
  script: string | null;
  source: EpisodeSource | null;
  audioKey: string | null;
}

export interface EpisodeAudioFailure {
  ok: false;
  status: 404 | 409 | 502 | 503;
  reason: string;
}

export type EpisodeAudioOutcome = AudioSuccess | EpisodeAudioFailure;

export interface EpisodeService {
  dayFor(ageTarget: number): EpisodeDay;
  episodeFor(ageTarget: number): Promise<EpisodeView>;
  audioFor(ageTarget: number, audioKey: string): Promise<EpisodeAudioOutcome>;
}

export interface EpisodeServiceOptions {
  llm: Pick<OpenRouterClient, 'complete'> | null;
  llmModel?: string;
  provider: SpeechProvider | null;
  cache: AudioCache;
  timeZone?: string;
  maxStories?: number;
  maxChars?: number;
  chunkChars?: number;
  retryAfterMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  logger?: Logger;
}

const EMPTY: EpisodeView = { date: null, articles: [], script: null, source: null, audioKey: null };

const TEN_MINUTES = 10 * 60 * 1000;

/** The model client the episode is written with, sized in env.ts. */
export function createPodcastLlm(): OpenRouterClient | null {
  return LLM_ENABLED
    ? new OpenRouterClient({
        maxTokens: PODCAST_LLM_MAX_TOKENS,
        timeoutMs: PODCAST_LLM_TIMEOUT_MS,
        maxRetries: PODCAST_LLM_MAX_RETRIES,
      })
    : null;
}

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
        // Every field the model reads: an editor's edit to any of them is a new episode.
        ...parts.stories.map((s) => [s.id, ...storyTexts(s)].join('\n')),
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
  const maxAttempts = options.maxAttempts ?? PODCAST_MAX_ATTEMPTS;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? logger.child({ area: 'podcast' });

  const writing = new Map<string, Promise<StoredEpisode>>();
  const speaking = new Map<string, Promise<EpisodeAudioOutcome>>();

  const dayFor = (ageTarget: number): EpisodeDay =>
    articles.listLatestPublishedDayForAge(ageTarget, timeZone, maxStories);

  const inputsFor = (ageTarget: number) => {
    const day = dayFor(ageTarget);
    if (!day.date || day.articles.length === 0) return null;

    const stories = day.articles.map(toEpisodeStory);
    const key = episodeKey({
      version: EPISODE_PROMPT_VERSION,
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

    for (const story of inputs.stories) {
      for (const field of storyTexts(story)) {
        const tripped = detectInjection(field);
        if (tripped) return fallback(inputs, `A story's text reads as an instruction (${tripped}).`, false);
      }
    }

    const result = await llm.complete({
      prompt: renderEpisodePrompt(inputs.stories, bandForAge(inputs.ageTarget), maxChars),
    });
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
    const attempts = (previous?.attempts ?? 0) + 1;
    // A model that keeps failing would otherwise be paid for every ten minutes, all day.
    const givenUp = composed.retryAfter !== null && attempts >= maxAttempts;
    const at = now().toISOString();
    const episode: StoredEpisode = {
      key: inputs.key,
      ageTarget: inputs.ageTarget,
      date: inputs.date,
      articleIds: inputs.articles.map((article) => article.id),
      ...composed,
      ...(givenUp && { retryAfter: null, reason: `${composed.reason} Stopped after ${attempts} attempts.` }),
      attempts,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    episodes.upsert(episode);

    const fields = { key: episode.key, ageTarget: episode.ageTarget, date: episode.date };
    if (episode.source === 'fallback') {
      log.warn(
        { ...fields, reason: episode.reason, retryAfter: episode.retryAfter, attempts },
        'podcast episode used the fallback',
      );
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
    const state: { failure: string | null; next: number } = { failure: null, next: 0 };

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
      return { ok: false, status: 502, reason: state.failure };
    }

    const joined = voice.format === 'mp3' ? joinMp3(audio) : Buffer.concat(audio);
    await cache.write(key, joined);
    return {
      ok: true, body: audioFromBuffer(joined), contentType: SPEECH_CONTENT_TYPES[voice.format],
      key, cached: false,
    };
  };

  return {
    dayFor,

    async episodeFor(ageTarget) {
      const inputs = inputsFor(ageTarget);
      if (!inputs) return EMPTY;

      const stored = episodes.findByKey(inputs.key);
      if (stored && stillStands(stored)) return view(inputs, stored);

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
