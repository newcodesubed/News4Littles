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
  service?: EpisodeService;
}

const AUDIO_KEY = /^[0-9a-f]{64}\.(mp3|wav|opus)$/;

export function createPodcastRouter(db: Database, options: PodcastRouterOptions = {}): Router {
  const router = Router();
  const readAgeTarget = createAgeTargetReader(db);

  const provider = options.service ? null : createSpeechProvider();
  const service =
    options.service ??
    createEpisodeService(db, {
      llm: LLM_ENABLED ? new OpenRouterClient({ timeoutMs: PODCAST_LLM_TIMEOUT_MS, maxRetries: 0 }) : null,
      provider,
      cache: provider ? createFileAudioCache(AUDIO_CACHE_DIR) : createMemoryAudioCache(),
    });

  router.get('/podcast', async (req, res) => {
    res.json(await service.episodeFor(readAgeTarget(req.query.age)));
  });

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
