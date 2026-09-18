/**
 * Public audio route (PRD §3.5). Read-only, unauthenticated, published only.
 *
 * Synthesis happens inside the request, so the FIRST listener of a story waits
 * a few seconds; everyone after them is served from the cache. Deliberately the
 * simple version: no queue, no pre-generation, no job table.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { MAX_AGE, MIN_AGE, bandForAge } from '../../core/article.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';
import { AUDIO_CACHE_DIR } from '../../env.js';
import { createAudioService, type AudioService } from '../../services/audioService.js';
import { createFileAudioCache, createMemoryAudioCache } from '../../tts/audioCache.js';
import { createSpeechProvider } from '../../tts/index.js';

export interface AudioRouterOptions {
  /** Injected by tests; production builds the configured provider and cache. */
  service?: AudioService;
}

export function createAudioRouter(db: Database, options: AudioRouterOptions = {}): Router {
  const router = Router();
  const settings = createSettingsRepository(db);

  // No provider means nothing is ever written, so no cache directory is
  // created — a test run or a key-less deployment leaves no empty data/audio.
  const provider = options.service ? null : createSpeechProvider();
  const service =
    options.service ??
    createAudioService(db, {
      provider,
      cache: provider ? createFileAudioCache(AUDIO_CACHE_DIR) : createMemoryAudioCache(),
    });

  /** Same lenient rule as the JSON routes: an odd age falls back, never 400s. */
  const readAgeTarget = (raw: unknown): number => {
    const age = Number(raw);
    const usable = Number.isInteger(age) && age >= MIN_AGE && age <= MAX_AGE;
    return bandForAge(usable ? age : settings.getAppSettings().defaultAge).minAge;
  };

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

    // The key hashes the script, model and voice, so it is a strong validator:
    // change any of them and the ETag changes with it.
    res.setHeader('ETag', `"${result.key}"`);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', String(result.body.size));
    // Revalidate every time, or a regenerated story keeps playing the old audio.
    res.setHeader('Cache-Control', 'public, no-cache');

    if (req.headers['if-none-match'] === `"${result.key}"`) {
      res.status(304).end();
      return;
    }

    const audio = result.body.open();

    // Headers are already sent by the time a stream can fail, so there is no
    // error page to send; dropping the connection at least lets the browser
    // report a truncated file instead of treating half a story as complete.
    audio.on('error', (error: Error) => {
      console.error(`[tts] stream failed for ${result.key}: ${error.message}`);
      res.destroy();
    });
    // A listener who navigates away would otherwise leave the file handle open.
    res.on('close', () => audio.destroy());

    audio.pipe(res);
  });

  return router;
}
