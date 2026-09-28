/**
 * Public audio route (PRD §3.5). Read-only, unauthenticated, published only.
 *
 * Synthesis happens inside the request, so the FIRST listener of a story waits
 * a few seconds; everyone after them is served from the cache. Deliberately the
 * simple version: no queue, no pre-generation, no job table.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { AUDIO_CACHE_DIR } from '../../env.js';
import { createAudioService, type AudioService } from '../../services/audioService.js';
import { createFileAudioCache, createMemoryAudioCache } from '../../tts/audioCache.js';
import { createSpeechProvider } from '../../tts/index.js';
import { createAgeTargetReader } from './ageTarget.js';
import { sendAudio } from './sendAudio.js';

export interface AudioRouterOptions {
  /** Injected by tests; production builds the configured provider and cache. */
  service?: AudioService;
}

export function createAudioRouter(db: Database, options: AudioRouterOptions = {}): Router {
  const router = Router();
  const readAgeTarget = createAgeTargetReader(db);

  // No provider means nothing is ever written, so no cache directory is
  // created — a test run or a key-less deployment leaves no empty data/audio.
  const provider = options.service ? null : createSpeechProvider();
  const service =
    options.service ??
    createAudioService(db, {
      provider,
      cache: provider ? createFileAudioCache(AUDIO_CACHE_DIR) : createMemoryAudioCache(),
    });

  /**
   * GET /api/articles/:id/audio[?age=N] -> the story read aloud.
   *
   * 404 for anything unpublished, matching GET /api/articles/:id: a 403 would
   * confirm the story exists and let the review queue be enumerated.
   */
  router.get('/articles/:id/audio', async (req, res) => {
    const result = await service.forArticle(req.params.id, readAgeTarget(req.query.age));

    if (!result.ok) {
      res.status(result.status).json({ error: result.reason });
      return;
    }

    sendAudio(req, res, result);
  });

  return router;
}
