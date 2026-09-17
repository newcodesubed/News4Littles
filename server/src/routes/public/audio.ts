/**
 * Public audio route (PRD §3.5). Read-only, unauthenticated, published only.
 *
 * Split from ./articles.ts because it answers with bytes rather than JSON, and
 * because everything it needs — a provider, a cache — is wiring that the JSON
 * routes should not have to carry.
 *
 * The synthesis happens inside the request, so the FIRST listener of a story
 * waits a few seconds for the provider. Everyone after them is served from the
 * cache. That is the deliberate simple version: no queue, no pre-generation, no
 * job table.
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

  // With speech switched off there is no provider and nothing will ever be
  // written, so the cache directory is not created either — a test run or a
  // key-less deployment leaves no empty data/audio behind.
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

    // The key is a hash of the script, the model and the voice, so it is a
    // genuine strong validator: if any of those change, so does the ETag.
    res.setHeader('ETag', `"${result.key}"`);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', String(result.body.size));
    // Immutable for a day: the URL's content only changes when an editor
    // rewrites the script, and then the ETag changes with it.
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (req.headers['if-none-match'] === `"${result.key}"`) {
      res.status(304).end();
      return;
    }

    // Streamed, not buffered: half a megabyte per listener held in memory is
    // the wrong shape for a file this size.
    const audio = result.body.open();

    // A stream that dies mid-response cannot be turned into an error page —
    // the status and headers are already gone. Dropping the connection at
    // least lets the browser report a truncated file instead of treating a
    // half-story as complete.
    audio.on('error', (error: Error) => {
      console.error(`[tts] stream failed for ${result.key}: ${error.message}`);
      res.destroy();
    });
    // A listener who navigates away mid-story leaves the file handle open
    // unless the stream is told the response is over.
    res.on('close', () => audio.destroy());

    audio.pipe(res);
  });

  return router;
}
