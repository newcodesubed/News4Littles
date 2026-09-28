/**
 * The daily podcast episode (spec §8). Read-only, unauthenticated, published
 * stories only — the service reads them through the same hardcoded-published
 * repository methods the article routes use.
 *
 * GET /api/podcast builds the script on the first load after the stories
 * change; GET /api/podcast/audio/:audioKey only ever speaks the script the page
 * was given, and answers 409 once it is no longer current (spec §2.1).
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { AUDIO_CACHE_DIR, LLM_ENABLED, PODCAST_LLM_TIMEOUT_MS } from '../../env.js';
import { OpenRouterClient } from '../../llm/openRouterClient.js';
import { createEpisodeService, type EpisodeService } from '../../services/episodeService.js';
import { createFileAudioCache, createMemoryAudioCache } from '../../tts/audioCache.js';
import { createSpeechProvider } from '../../tts/index.js';
import { createAgeTargetReader } from './ageTarget.js';
import { sendAudio } from './sendAudio.js';

export interface PodcastRouterOptions {
  /** Injected by tests; production builds the configured model, voice and cache. */
  service?: EpisodeService;
}

/**
 * What audioKey() produces. Checked before the key reaches the cache, which
 * joins it onto a directory path — anything else would be a way to ask for a
 * file outside it.
 */
const AUDIO_KEY = /^[0-9a-f]{64}\.(mp3|wav|opus)$/;

export function createPodcastRouter(db: Database, options: PodcastRouterOptions = {}): Router {
  const router = Router();
  const readAgeTarget = createAgeTargetReader(db);

  const provider = options.service ? null : createSpeechProvider();
  const service =
    options.service ??
    createEpisodeService(db, {
      // Short timeout and no retry: a page is waiting, and the fallback plays
      // in the meantime.
      llm: LLM_ENABLED ? new OpenRouterClient({ timeoutMs: PODCAST_LLM_TIMEOUT_MS, maxRetries: 0 }) : null,
      provider,
      cache: provider ? createFileAudioCache(AUDIO_CACHE_DIR) : createMemoryAudioCache(),
    });

  /** GET /api/podcast[?age=N] -> the latest day's episode for N's band. */
  router.get('/podcast', async (req, res) => {
    res.json(await service.episodeFor(readAgeTarget(req.query.age)));
  });

  /** GET /api/podcast/audio/:audioKey[?age=N] -> that episode read aloud. */
  router.get('/podcast/audio/:audioKey', async (req, res) => {
    if (!AUDIO_KEY.test(req.params.audioKey)) {
      res.status(404).json({ error: 'No such episode audio.' });
      return;
    }

    const result = await service.audioFor(readAgeTarget(req.query.age), req.params.audioKey);
    if (!result.ok) {
      res.status(result.status).json({ error: result.reason });
      return;
    }

    sendAudio(req, res, result);
  });

  return router;
}
