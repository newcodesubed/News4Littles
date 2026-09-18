import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStoryAudio } from '../lib/useStoryAudio';

/**
 * jsdom has an <audio> element but no media pipeline — HTMLMediaElement.play
 * is "not implemented" — so the element is stubbed. Everything asserted here is
 * the hook's own state machine, not the browser's.
 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  /** Set to make play() reject, the way a blocked or unloadable source does. */
  static rejectPlay = false;

  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  currentTime = 0;
  pause = vi.fn();
  play = vi.fn(async () => {
    if (FakeAudio.rejectPlay) throw new Error('blocked');
  });

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }

  static get last(): FakeAudio {
    return FakeAudio.instances[FakeAudio.instances.length - 1];
  }
}

const URL_A = 'http://api/api/articles/a1/audio?age=8';
const URL_B = 'http://api/api/articles/b2/audio?age=8';

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.rejectPlay = false;
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useStoryAudio', () => {
  it('starts idle and silent', () => {
    const { result } = renderHook(() => useStoryAudio(URL_A));

    expect(result.current.status).toBe('idle');
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('requests the story audio only once play is pressed', async () => {
    // Synthesis is billed per request, so a page of ten stories must not fetch
    // ten audio files nobody asked to hear.
    const { result } = renderHook(() => useStoryAudio(URL_A));

    await act(async () => result.current.play());

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.last.src).toBe(URL_A);
    expect(FakeAudio.last.play).toHaveBeenCalled();
  });

  it('stays loading until the audio actually starts', async () => {
    // The first listener waits for the provider to synthesise the story, which
    // is seconds — a button that looks idle for that long looks broken.
    const { result } = renderHook(() => useStoryAudio(URL_A));

    await act(async () => result.current.play());
    expect(result.current.loading).toBe(true);
    expect(result.current.playing).toBe(false);

    act(() => FakeAudio.last.onplaying?.());
    expect(result.current.loading).toBe(false);
    expect(result.current.playing).toBe(true);
  });

  it('returns to idle when the story ends', async () => {
    const { result } = renderHook(() => useStoryAudio(URL_A));
    await act(async () => result.current.play());
    act(() => FakeAudio.last.onplaying?.());

    act(() => FakeAudio.last.onended?.());

    expect(result.current.status).toBe('idle');
  });

  it('stop pauses and rewinds, so play starts the story over', async () => {
    const { result } = renderHook(() => useStoryAudio(URL_A));
    await act(async () => result.current.play());
    act(() => FakeAudio.last.onplaying?.());
    FakeAudio.last.currentTime = 12;

    act(() => result.current.stop());

    expect(FakeAudio.last.pause).toHaveBeenCalled();
    expect(FakeAudio.last.currentTime).toBe(0);
    expect(result.current.playing).toBe(false);
  });

  it('reuses the loaded element on a replay instead of paying again', async () => {
    const { result } = renderHook(() => useStoryAudio(URL_A));
    await act(async () => result.current.play());
    act(() => FakeAudio.last.onended?.());

    await act(async () => result.current.play());

    expect(FakeAudio.instances).toHaveLength(1);
  });

  it('stops the first story when a second one starts', async () => {
    // Nothing in the browser prevents two <audio> elements playing at once,
    // which is exactly why the hook has to.
    const first = renderHook(() => useStoryAudio(URL_A));
    const second = renderHook(() => useStoryAudio(URL_B));
    await act(async () => first.result.current.play());
    act(() => FakeAudio.last.onplaying?.());
    const firstElement = FakeAudio.last;

    await act(async () => second.result.current.play());
    act(() => FakeAudio.last.onplaying?.());

    expect(firstElement.pause).toHaveBeenCalled();
    expect(first.result.current.playing).toBe(false);
    expect(second.result.current.playing).toBe(true);
  });

  it('stops the old version when the reading age changes mid-story', async () => {
    // Moving the slider swaps the src. An element that is merely dropped keeps
    // playing, with nothing left holding a reference to stop it.
    const { result, rerender } = renderHook(({ url }) => useStoryAudio(url), {
      initialProps: { url: URL_A },
    });
    await act(async () => result.current.play());
    act(() => FakeAudio.last.onplaying?.());
    const oldElement = FakeAudio.last;

    rerender({ url: URL_B });

    expect(oldElement.pause).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);

    // …and the next play fetches the new version, not the cached old element.
    await act(async () => result.current.play());
    expect(FakeAudio.last.src).toBe(URL_B);
  });

  it('pauses on unmount, so a story does not outlive the page', async () => {
    const { result, unmount } = renderHook(() => useStoryAudio(URL_A));
    await act(async () => result.current.play());
    const element = FakeAudio.last;

    unmount();

    expect(element.pause).toHaveBeenCalled();
  });

  it('shows a child-readable message when the audio cannot be fetched', async () => {
    // A 503 (speech switched off), a 502 (provider down) and a 404 all arrive
    // as the same opaque element error.
    const { result } = renderHook(() => useStoryAudio(URL_A));
    await act(async () => result.current.play());

    act(() => FakeAudio.last.onerror?.());

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/could not be read aloud/i);
    expect(result.current.playing).toBe(false);
  });

  it('builds a fresh element after a failure, so retrying can work', async () => {
    const { result } = renderHook(() => useStoryAudio(URL_A));
    await act(async () => result.current.play());
    act(() => FakeAudio.last.onerror?.());

    await act(async () => result.current.play());

    expect(FakeAudio.instances).toHaveLength(2);
  });

  it('reports a rejected play() as an error rather than sitting on loading', async () => {
    // play() rejects when the source will not load at all, and under autoplay
    // policy. Either way the button must not spin forever.
    FakeAudio.rejectPlay = true;
    const { result } = renderHook(() => useStoryAudio(URL_A));

    await act(async () => result.current.play());

    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/could not be read aloud/i);
  });

  it('does nothing without a URL', async () => {
    const { result } = renderHook(() => useStoryAudio(null));

    await act(async () => result.current.play());

    expect(FakeAudio.instances).toHaveLength(0);
  });
});
