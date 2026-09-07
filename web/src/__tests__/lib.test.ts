/** The API client and the async hook every page depends on. */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, ApiError, fetchArticle, fetchPublishedArticles } from '../lib/api';
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
  it('asks only for published stories (§11.1)', async () => {
    respond([]);
    await fetchPublishedArticles();
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('status=published');
  });

  it('returns the parsed body', async () => {
    respond([{ id: 'a' }]);
    expect(await fetchPublishedArticles()).toEqual([{ id: 'a' }]);
  });
});

describe('fetchArticle', () => {
  it('encodes the id so an odd one cannot break the URL', async () => {
    respond({});
    await fetchArticle('a b/c');
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('a%20b%2Fc');
  });
});

describe('error handling', () => {
  it('turns an unreachable API into a message naming the cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchPublishedArticles()).rejects.toThrow(/Is the server running/);
  });

  it("surfaces the server's own error message", async () => {
    respond({ error: 'No article with id ‘x’.' }, false, 404);
    await expect(fetchArticle('x')).rejects.toThrow(/No article with id/);
  });

  it('falls back to the status code when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => { throw new Error('not json'); },
    }) as unknown as Response));
    await expect(fetchArticle('x')).rejects.toThrow(/500/);
  });

  it('carries the status code on the error', async () => {
    respond({ error: 'gone' }, false, 404);
    await expect(fetchArticle('x')).rejects.toMatchObject({ status: 404, name: 'ApiError' });
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
