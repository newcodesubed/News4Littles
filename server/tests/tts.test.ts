/**
 * Text-to-speech — the provider seam, the cache and the audio route (PRD §3.5).
 *
 * Nothing here reaches a real provider: the OpenRouter adapter gets an injected
 * fetch, and the service gets a stub provider. TTS is billed by input length,
 * so a suite that spoke for real would cost money on every run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createTestContext, insertKidArticle, type TestContext } from './helpers.js';
import { audioKey, createFileAudioCache, createMemoryAudioCache } from '../src/tts/audioCache.js';
import { OpenRouterSpeechProvider } from '../src/tts/openRouterSpeech.js';
import { createSpeechProvider, PROVIDER_IDS } from '../src/tts/index.js';
import type { SpeechProvider, SpeechResult } from '../src/tts/types.js';
import {
  assembleScript, createAudioService, scriptFor,
} from '../src/services/audioService.js';
import { createAudioRouter } from '../src/routes/public/audio.js';
import type { KidArticle } from '../src/core/article.js';

const MP3 = Buffer.from('ID3-pretend-audio');

/** A response the way the real endpoint sends audio: raw bytes, not JSON. */
const audioResponse = (bytes = MP3) =>
  new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });

const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A provider that speaks instantly and records what it was asked for. */
function stubProvider(overrides: Partial<SpeechProvider> = {}) {
  const calls: string[] = [];
  const provider: SpeechProvider = {
    id: 'stub',
    model: 'stub-model',
    voice: 'stub-voice',
    format: 'mp3',
    async speak(request): Promise<SpeechResult> {
      calls.push(request.text);
      return {
        ok: true, audio: MP3, contentType: 'audio/mpeg', format: 'mp3',
        model: 'stub-model', voice: 'stub-voice', elapsedMs: 1,
      };
    },
    ...overrides,
  };
  return { provider, calls };
}

describe('OpenRouterSpeechProvider', () => {
  it('posts the script to the speech endpoint and returns the bytes', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const provider = new OpenRouterSpeechProvider({
      apiKey: 'test-key', model: 'microsoft/mai-voice-2', voice: 'en-US-AvaNeural', fetchImpl,
    });

    const result = await provider.speak({ text: 'Hello friends.' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audio.equals(MP3)).toBe(true);
    expect(result.contentType).toBe('audio/mpeg');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'microsoft/mai-voice-2',
      input: 'Hello friends.',
      voice: 'en-US-AvaNeural',
      response_format: 'mp3',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('reports a provider error without throwing, and without leaking the key', async () => {
    // A voice id that does not belong to the model arrives exactly like this.
    const fetchImpl = vi.fn(async () => errorResponse(400, 'Provider returned 400'));
    const provider = new OpenRouterSpeechProvider({ apiKey: 'secret-key', fetchImpl, maxRetries: 0 });

    const result = await provider.speak({ text: 'Hello.' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('400');
    expect(result.reason).not.toContain('secret-key');
    expect(result.transient).toBe(false);
  });

  it('retries a transient failure once, and only once', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(429, 'Slow down'));
    const provider = new OpenRouterSpeechProvider({ apiKey: 'k', fetchImpl, maxRetries: 1 });

    const result = await provider.speak({ text: 'Hello.' });

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(400, 'Model does not exist'));
    const provider = new OpenRouterSpeechProvider({ apiKey: 'k', fetchImpl, maxRetries: 1 });

    await provider.speak({ text: 'Hello.' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats an empty 200 as a failure rather than caching silence', async () => {
    const fetchImpl = vi.fn(async () => audioResponse(Buffer.alloc(0)));
    const provider = new OpenRouterSpeechProvider({ apiKey: 'k', fetchImpl, maxRetries: 0 });

    const result = await provider.speak({ text: 'Hello.' });

    expect(result.ok).toBe(false);
  });

  it('never calls out with no key configured', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const provider = new OpenRouterSpeechProvider({ apiKey: '', fetchImpl });

    const result = await provider.speak({ text: 'Hello.' });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createSpeechProvider', () => {
  it('returns nothing when speech is switched off', () => {
    // vitest.config.ts pins TTS_ENABLED=false so no suite can spend money.
    expect(createSpeechProvider()).toBeNull();
  });

  it('rejects an unknown provider id as the .env typo it is', () => {
    // Not a silent fallback: a misspelled TTS_PROVIDER should fail loudly at
    // startup rather than quietly serve a voice nobody chose.
    expect(() => createSpeechProvider('11labs')).toThrow(/not a known provider/);
  });

  it('lists the providers that can be selected', () => {
    expect(PROVIDER_IDS).toContain('openrouter');
  });
});

describe('audioKey', () => {
  const base = {
    text: 'Hello friends.', provider: 'openrouter',
    model: 'microsoft/mai-voice-2', voice: 'en-US-AvaNeural', format: 'mp3',
  } as const;

  it('is stable for the same rendering', () => {
    expect(audioKey(base)).toBe(audioKey({ ...base }));
  });

  it('changes when anything that changes the sound changes', () => {
    // This is the whole invalidation story: an edited script or a new voice in
    // .env must not serve the old audio.
    for (const change of [
      { text: 'Hello friend.' },
      { provider: 'elevenlabs' },
      { model: 'x-ai/grok-voice-tts-1.0' },
      { voice: 'en-US-JennyNeural' },
      { format: 'wav' as const },
    ]) {
      expect(audioKey({ ...base, ...change })).not.toBe(audioKey(base));
    }
  });

  it('ends in the format, so a cached file is recognisable on disk', () => {
    expect(audioKey(base).endsWith('.mp3')).toBe(true);
  });
});

describe('file audio cache', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'n4l-audio-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Drain a stream, the way the route's pipe does. */
  const drain = async (audio: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of audio) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  it('round-trips bytes', async () => {
    const cache = createFileAudioCache(dir);
    await cache.write('abc.mp3', MP3);

    const hit = await cache.read('abc.mp3');

    expect(hit?.size).toBe(MP3.byteLength);
    expect((await drain(hit!.open())).equals(MP3)).toBe(true);
  });

  it('reports the size without reading the file', async () => {
    // A hit must cost one metadata call, not half a megabyte into memory.
    const cache = createFileAudioCache(dir);
    await cache.write('sized.mp3', MP3);

    expect((await cache.read('sized.mp3'))?.size).toBe(MP3.byteLength);
  });

  it('opens a fresh stream each time, so two listeners do not share one', async () => {
    const cache = createFileAudioCache(dir);
    await cache.write('shared.mp3', MP3);
    const hit = await cache.read('shared.mp3');

    const [first, second] = await Promise.all([drain(hit!.open()), drain(hit!.open())]);

    expect(first.equals(MP3)).toBe(true);
    expect(second.equals(MP3)).toBe(true);
  });

  it('misses rather than throwing for something never written', async () => {
    expect(await createFileAudioCache(dir).read('nothing-here.mp3')).toBeUndefined();
  });

  it('leaves no partial file behind for a reader to serve', async () => {
    // write-then-rename: the only name that ever exists is a complete file.
    const cache = createFileAudioCache(dir);
    await cache.write('atomic.mp3', MP3);

    expect((await cache.read('atomic.mp3'))?.size).toBe(MP3.byteLength);
  });
});

describe('scriptFor', () => {
  const article = (o: Partial<KidArticle> = {}): KidArticle => ({
    id: 'a1', originalId: 'r1', ageTarget: 8, kidHeadline: 'H', summary: 'A coral garden was found.',
    whatHappened: 'W', whyItMatters: 'Y',
    vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
    thinkAbout: 'What lives there?', audioScript: null, feelingNote: null, safety: 'calm',
    contentWarnings: null, category: 'Environment', readingMinutes: 3, sourceName: 'BBC News',
    sourceUrl: 'https://example.com', status: 'published', rejectReason: null, editedByHuman: false,
    createdAt: '2026-09-04T10:00:00.000Z', publishedAt: '2026-09-04T10:00:00.000Z', ...o,
  });

  it('speaks the reviewed script when there is one', () => {
    expect(scriptFor(article({ audioScript: 'A robot went down to the reef.' })))
      .toBe('A robot went down to the reef.');
  });

  it('falls back for a story published before audio scripts existed', () => {
    expect(scriptFor(article())).toBe(assembleScript(article()));
  });

  it('assembles the fallback exactly as the podcast page renders it', () => {
    // This string is duplicated in web/src/pages/Podcast.tsx, which shows it on
    // screen while this one is spoken. §2.2: a child hears what is written.
    expect(assembleScript(article())).toBe(
      'Our next story is from BBC News. A coral garden was found. ' +
        'Here\'s a fun word: "reef" — A ridge under the sea. ' +
        'Something to wonder about: What lives there?',
    );
  });

  it('treats a whitespace-only script as absent, not as silence', () => {
    expect(scriptFor(article({ audioScript: '   ' }))).toBe(assembleScript(article()));
  });
});

describe('audio service', () => {
  let ctx: TestContext;
  beforeAll(() => {
    ctx = createTestContext();
    insertKidArticle(ctx.db, { id: 'pub-a', status: 'published', audioScript: 'One two three.' });
    insertKidArticle(ctx.db, { id: 'pending-a', status: 'pending_review', audioScript: 'Secret.' });
  });
  afterAll(() => ctx.close());

  it('synthesises a published story once and serves the cache after that', async () => {
    const { provider, calls } = stubProvider();
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });

    const first = await service.forArticle('pub-a', 8);
    const second = await service.forArticle('pub-a', 8);

    expect(first.ok && first.cached).toBe(false);
    expect(second.ok && second.cached).toBe(true);
    // The bill is paid once, however many children press play.
    expect(calls).toEqual(['One two three.']);
  });

  it('speaks the reviewed script and nothing else', async () => {
    const { provider, calls } = stubProvider();
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });

    await service.forArticle('pub-a', 8);

    expect(calls[0]).toBe('One two three.');
  });

  it('refuses a story that is not published, without saying it exists', async () => {
    // §2.2 again: asking for a story to be read aloud must not be a way around
    // human review, and a 403 would confirm the queue's contents.
    const { provider, calls } = stubProvider();
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });

    const result = await service.forArticle('pending-a', 8);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers 503 when no provider is configured', async () => {
    const service = createAudioService(ctx.db, {
      provider: null, cache: createMemoryAudioCache(),
    });

    const result = await service.forArticle('pub-a', 8);

    expect(!result.ok && result.status).toBe(503);
  });

  it('turns a provider failure into 502, not a thrown request', async () => {
    const { provider } = stubProvider({
      speak: async () => ({ ok: false, reason: 'OpenRouter returned 429', transient: true, elapsedMs: 1 }),
    });
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });

    const result = await service.forArticle('pub-a', 8);

    expect(!result.ok && result.status).toBe(502);
  });

  it('pays once when a crowd asks for the same uncached story at once', async () => {
    // Five children pressing play in the same second used to be five cache
    // misses, five provider calls and one bill multiplied by five.
    let calls = 0;
    const { provider } = stubProvider({
      speak: async () => {
        calls += 1;
        // Long enough that all five requests are genuinely in flight together.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true, audio: MP3, contentType: 'audio/mpeg', format: 'mp3',
          model: 'stub-model', voice: 'stub-voice', elapsedMs: 20,
        };
      },
    });
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });

    const all = await Promise.all(
      Array.from({ length: 5 }, () => service.forArticle('pub-a', 8)),
    );

    expect(calls).toBe(1);
    expect(all.every((r) => r.ok)).toBe(true);
  });

  it('gives every waiter its own stream, not one they fight over', async () => {
    const { provider } = stubProvider();
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });

    const all = await Promise.all(
      Array.from({ length: 3 }, () => service.forArticle('pub-a', 8)),
    );
    const bodies = await Promise.all(
      all.map(async (r) => {
        const chunks: Buffer[] = [];
        for await (const chunk of (r as { body: { open(): Readable } }).body.open()) {
          chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks);
      }),
    );

    expect(bodies.every((b) => b.equals(MP3))).toBe(true);
  });

  it('lets a later request retry after the shared attempt failed', async () => {
    // The in-flight entry must be cleared on failure too, or one blip would
    // be replayed to everyone who asked afterwards.
    let attempt = 0;
    const { provider } = stubProvider({
      speak: async (): Promise<SpeechResult> => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, reason: 'blip', transient: true, elapsedMs: 1 }
          : {
              ok: true, audio: MP3, contentType: 'audio/mpeg', format: 'mp3',
              model: 'stub-model', voice: 'stub-voice', elapsedMs: 1,
            };
      },
    });
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });

    expect((await service.forArticle('pub-a', 8)).ok).toBe(false);
    expect((await service.forArticle('pub-a', 8)).ok).toBe(true);
  });

  it('never caches a failure, so a blip is not permanent', async () => {
    let attempt = 0;
    const cache = createMemoryAudioCache();
    const { provider } = stubProvider({
      speak: async (): Promise<SpeechResult> => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, reason: 'blip', transient: true, elapsedMs: 1 }
          : {
              ok: true, audio: MP3, contentType: 'audio/mpeg', format: 'mp3',
              model: 'stub-model', voice: 'stub-voice', elapsedMs: 1,
            };
      },
    });
    const service = createAudioService(ctx.db, { provider, cache });

    expect((await service.forArticle('pub-a', 8)).ok).toBe(false);
    expect((await service.forArticle('pub-a', 8)).ok).toBe(true);
  });

  it('truncates a runaway script before it is billed', async () => {
    insertKidArticle(ctx.db, {
      id: 'pub-long', status: 'published', audioScript: 'x'.repeat(5000),
    });
    const { provider, calls } = stubProvider();
    const service = createAudioService(ctx.db, {
      provider, cache: createMemoryAudioCache(), maxChars: 100,
    });

    await service.forArticle('pub-long', 8);

    expect(calls[0]).toHaveLength(100);
  });
});

describe('GET /api/articles/:id/audio', () => {
  let ctx: TestContext;
  beforeAll(() => {
    ctx = createTestContext();
    insertKidArticle(ctx.db, { id: 'pub-b', status: 'published', audioScript: 'One two three.' });
    insertKidArticle(ctx.db, { id: 'pending-b', status: 'pending_review' });
  });
  afterAll(() => ctx.close());

  /**
   * A server carrying only the audio route, wired to a stub voice instead of a
   * paid one — ctx's app deliberately has speech switched off.
   */
  const startWithStubVoice = () => {
    const { provider } = stubProvider();
    const service = createAudioService(ctx.db, { provider, cache: createMemoryAudioCache() });
    const app = express();
    app.use('/api', createAudioRouter(ctx.db, { service }));
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    return { server, base: `http://127.0.0.1:${port}` };
  };

  it('serves audio bytes with the right content type', async () => {
    const { server, base } = startWithStubVoice();

    const response = await fetch(`${base}/api/articles/pub-b/audio?age=8`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}\.mp3"$/);
    expect(body.equals(MP3)).toBe(true);

    server.close();
  });

  it('answers 304 for a listener who already has this exact rendering', async () => {
    const { server, base } = startWithStubVoice();
    const url = `${base}/api/articles/pub-b/audio?age=8`;

    const etag = (await fetch(url)).headers.get('etag')!;
    const again = await fetch(url, { headers: { 'If-None-Match': etag } });

    expect(again.status).toBe(304);
    server.close();
  });

  it('404s an unpublished story, unauthenticated, like the JSON route does', async () => {
    const { server, base } = startWithStubVoice();

    const response = await fetch(`${base}/api/articles/pending-b/audio?age=8`);

    expect(response.status).toBe(404);
    server.close();
  });

  it('503s while speech is switched off, rather than erroring the page', async () => {
    // The real app is built here, and vitest.config.ts has TTS_ENABLED=false.
    const response = await ctx.anon('/api/articles/pub-b/audio?age=8');
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/not configured/i);
  });
});
