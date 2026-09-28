import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import pino from 'pino';
import { createRequestLogger } from '../src/http/middleware/requestLogger.js';
import { createPodcastRouter } from '../src/routes/public/podcast.js';
import { createEpisodeService } from '../src/services/episodeService.js';
import { createMemoryAudioCache } from '../src/tts/audioCache.js';
import type { SpeechProvider } from '../src/tts/types.js';
import { createTestContext, insertKidArticle, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(() => {
  ctx = createTestContext();
  insertKidArticle(ctx.db, {
    id: 'pub-1', status: 'published', publishedAt: '2026-09-28T09:00:00.000Z',
    audioScript: 'A little robot swam down to a coral reef and counted the fish.',
  });
  insertKidArticle(ctx.db, { id: 'pending-1', status: 'pending_review', audioScript: 'Not reviewed yet.' });
});
afterAll(() => ctx.close());

const voice: SpeechProvider = {
  id: 'stub', model: 'stub-model', voice: 'stub-voice', format: 'mp3',
  async speak() {
    return {
      ok: true, audio: Buffer.from('ID3-audio'), contentType: 'audio/mpeg', format: 'mp3',
      model: 'stub-model', voice: 'stub-voice', elapsedMs: 1,
    };
  },
};

const startWithStubVoice = () => {
  const service = createEpisodeService(ctx.db, {
    llm: null, provider: voice, cache: createMemoryAudioCache(), timeZone: 'UTC',
  });
  const app = express();
  app.use(createRequestLogger(pino({ level: 'silent' })));
  app.use('/api', createPodcastRouter(ctx.db, { service }));
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}` };
};

describe('GET /api/podcast', () => {
  it('serves the day\'s episode, published stories only', async () => {
    const response = await ctx.anon('/api/podcast?age=8');
    const episode = await response.json();

    expect(response.status).toBe(200);
    expect(episode.articles.map((a: { id: string }) => a.id)).toEqual(['pub-1']);
    expect(episode.source).toBe('fallback');
    expect(episode.script).toContain('A little robot swam down to a coral reef');
    expect(episode.script).not.toContain('Not reviewed yet.');
    expect(episode.audioKey).toBeNull();
  });

  it('answers an empty episode, not an error, for a band with no stories', async () => {
    const episode = await (await ctx.anon('/api/podcast?age=12')).json();
    expect(episode).toEqual({ date: null, articles: [], script: null, source: null, audioKey: null });
  });

  it('falls back to the default age for an odd one, rather than a 400', async () => {
    expect((await ctx.anon('/api/podcast?age=banana')).status).toBe(200);
  });
});

describe('GET /api/podcast/audio/:audioKey', () => {
  it('503s while speech is switched off', async () => {
    const response = await ctx.anon(`/api/podcast/audio/${'a'.repeat(64)}.mp3?age=8`);
    expect(response.status).toBe(503);
  });

  it('plays the episode the page was given', async () => {
    const { server, base } = startWithStubVoice();
    const { audioKey } = await (await fetch(`${base}/api/podcast?age=8`)).json();

    const response = await fetch(`${base}/api/podcast/audio/${audioKey}?age=8`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('etag')).toBe(`"${audioKey}"`);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('ID3-audio');
    server.close();
  });

  it('answers 304 to a listener who already has it', async () => {
    const { server, base } = startWithStubVoice();
    const { audioKey } = await (await fetch(`${base}/api/podcast?age=8`)).json();
    const url = `${base}/api/podcast/audio/${audioKey}?age=8`;
    await fetch(url);

    expect((await fetch(url, { headers: { 'If-None-Match': `"${audioKey}"` } })).status).toBe(304);
    server.close();
  });

  it('answers 409 for an episode that is no longer current', async () => {
    const { server, base } = startWithStubVoice();

    const response = await fetch(`${base}/api/podcast/audio/${'b'.repeat(64)}.mp3?age=8`);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/changed/);
    server.close();
  });

  it('404s anything that is not an audio key, before it gets near the cache directory', async () => {
    const { server, base } = startWithStubVoice();

    for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'abc.mp3', `${'a'.repeat(64)}.exe`]) {
      expect((await fetch(`${base}/api/podcast/audio/${bad}?age=8`)).status).toBe(404);
    }
    server.close();
  });
});
