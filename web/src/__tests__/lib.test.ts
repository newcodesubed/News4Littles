/** The API client and the async hook every page depends on. */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, ApiError, fetchArticle, fetchPublishedArticles } from '../lib/api';
import {
  AGE_BANDS,
  AGE_BAND_ANCHORS,
  MAX_AGE,
  MIN_AGE,
  ageBandLabel,
  bandForAge,
  formatAgeBand,
  isAgeBandAnchor,
} from '../lib/ageBands';
import { useAsync } from '../lib/useAsync';
import { needsFeelingNote } from '../lib/types';

afterEach(() => vi.unstubAllGlobals());

const respond = (body: unknown, ok = true, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response));

describe('API base URL', () => {
  it('has no trailing slash, so path joining is safe', () => {
    expect(API_BASE_URL).not.toMatch(/\/$/);
  });
});

describe('fetchPublishedArticles', () => {
  it('asks for the reader’s reading age (§6)', async () => {
    respond([]);
    await fetchPublishedArticles(11);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('age=11');
  });

  it('no longer sends a status, because the server decides it (§2.2)', async () => {
    // The endpoint serves published stories only, and not because the caller
    // asked: a status parameter used to make that promise the caller's job.
    respond([]);
    await fetchPublishedArticles(8);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain('status=');
  });

  it('returns the parsed body', async () => {
    respond([{ id: 'a' }]);
    expect(await fetchPublishedArticles(8)).toEqual([{ id: 'a' }]);
  });
});

describe('fetchArticle', () => {
  it('encodes the id so an odd one cannot break the URL', async () => {
    respond({});
    await fetchArticle('a b/c', 8);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('a%20b%2Fc');
  });

  it('sends the reading age, so the slider works on a story page (§6)', async () => {
    respond({});
    await fetchArticle('a1', 13);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('age=13');
  });
});

describe('error handling', () => {
  it('turns an unreachable API into a message naming the cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchPublishedArticles(8)).rejects.toThrow(/Is the server running/);
  });

  it("surfaces the server's own error message", async () => {
    respond({ error: 'No article with id ‘x’.' }, false, 404);
    await expect(fetchArticle('x', 8)).rejects.toThrow(/No article with id/);
  });

  it('falls back to the status code when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => { throw new Error('not json'); },
    }) as unknown as Response));
    await expect(fetchArticle('x', 8)).rejects.toThrow(/500/);
  });

  it('carries the status code on the error', async () => {
    respond({ error: 'gone' }, false, 404);
    await expect(fetchArticle('x', 8)).rejects.toMatchObject({ status: 404, name: 'ApiError' });
    expect(new ApiError('x', 404)).toBeInstanceOf(Error);
  });
});

describe('useAsync', () => {
  it('moves loading -> ready', async () => {
    const { result } = renderHook(() => useAsync(async () => 'value', []));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', data: 'value' }));
  });

  it('moves loading -> error with the message', async () => {
    const { result } = renderHook(() => useAsync(async () => { throw new Error('nope'); }, []));
    await waitFor(() => expect(result.current).toEqual({ status: 'error', message: 'nope' }));
  });

  it('ignores a superseded request, so stale data never renders', async () => {
    // A slow first call must not overwrite a fast second one.
    let resolveFirst: (v: string) => void = () => {};
    const first = new Promise<string>((r) => { resolveFirst = r; });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAsync(() => (id === '1' ? first : Promise.resolve('second')), [id]),
      { initialProps: { id: '1' } },
    );

    rerender({ id: '2' });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', data: 'second' }));

    resolveFirst('first');
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toEqual({ status: 'ready', data: 'second' });
  });
});

describe('needsFeelingNote', () => {
  it.each([
    ['calm', false],
    ['adult-nearby', true],
    ['skip-young', true],
  ])('%s -> %s', (safety, expected) => {
    expect(needsFeelingNote({ safety: safety as 'calm' })).toBe(expected);
  });
});

describe('reading bands (mirror of server/src/core/article.ts)', () => {
  it('covers the slider range contiguously', () => {
    expect(AGE_BANDS[0]!.minAge).toBe(MIN_AGE);
    expect(AGE_BANDS[AGE_BANDS.length - 1]!.maxAge).toBe(MAX_AGE);
    for (let i = 1; i < AGE_BANDS.length; i += 1) {
      expect(AGE_BANDS[i]!.minAge).toBe(AGE_BANDS[i - 1]!.maxAge + 1);
    }
  });

  it.each([[5, 5], [7, 5], [8, 8], [10, 8], [11, 11], [14, 11]])(
    'age %i belongs to the band anchored at %i',
    (age, anchor) => expect(bandForAge(age).minAge).toBe(anchor),
  );

  it('recognises exactly the anchors as storable ageTargets', () => {
    expect(AGE_BAND_ANCHORS).toEqual([5, 8, 11]);
    expect(isAgeBandAnchor(8)).toBe(true);
    expect(isAgeBandAnchor(6)).toBe(false);
  });

  it('labels a stored ageTarget by its whole band', () => {
    expect(ageBandLabel(8)).toBe('Ages 8–10');
    expect(formatAgeBand(bandForAge(14))).toBe('11–14');
  });
});
