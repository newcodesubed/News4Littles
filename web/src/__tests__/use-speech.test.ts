import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSentences, useSpeech } from '../lib/useSpeech';

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  constructor(public text: string) {}
}

let queue: FakeUtterance[];

beforeEach(() => {
  queue = [];
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', {
    speak: (u: FakeUtterance) => queue.push(u),
    cancel: () => { queue = []; },
  });
});
afterEach(() => {
  // Unmount every rendered hook here, while the stubbed globals are still in
  // place — RTL's own auto-cleanup afterEach was registered (at import time)
  // before this one, so Vitest's LIFO ordering would otherwise run
  // vi.unstubAllGlobals() first and leave `stop`'s effect cleanup calling a
  // global that no longer exists.
  cleanup();
  vi.unstubAllGlobals();
});

describe('toSentences', () => {
  it('splits on sentence endings and drops blanks', () => {
    expect(toSentences('One. Two!  Three?   ')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('returns a single chunk when there is no terminator', () => {
    expect(toSentences('no full stop here')).toEqual(['no full stop here']);
  });
});

describe('useSpeech', () => {
  it('queues one utterance per sentence, not one per script', () => {
    // Chrome truncates a single utterance after ~15s, so a whole story spoken
    // as one utterance cuts off mid-word.
    const { result } = renderHook(() => useSpeech('One. Two. Three.'));

    act(() => result.current.play());

    expect(queue.map((u) => u.text)).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('tracks which sentence is being spoken', () => {
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());

    act(() => queue[0].onstart?.());
    expect(result.current.current).toBe(0);
    expect(result.current.speaking).toBe(true);

    act(() => queue[1].onstart?.());
    expect(result.current.current).toBe(1);
  });

  it('clears the highlight when the last sentence ends', () => {
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());
    act(() => queue[1].onstart?.());
    act(() => queue[1].onend?.());

    expect(result.current.current).toBe(-1);
    expect(result.current.speaking).toBe(false);
  });

  it('stop cancels and clears the highlight', () => {
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());
    act(() => queue[0].onstart?.());

    act(() => result.current.stop());

    expect(result.current.current).toBe(-1);
  });

  it('cancels on unmount, so speech does not outlive the page', () => {
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak: (u: FakeUtterance) => queue.push(u), cancel });
    const { result, unmount } = renderHook(() => useSpeech('One.'));
    act(() => result.current.play());

    unmount();

    expect(cancel).toHaveBeenCalled();
  });

  it('reports unsupported when the browser has no speech synthesis', () => {
    vi.unstubAllGlobals();
    const { result } = renderHook(() => useSpeech('One.'));
    expect(result.current.supported).toBe(false);
  });

  it('has nothing to say for a null script', () => {
    const { result } = renderHook(() => useSpeech(null));
    expect(result.current.sentences).toEqual([]);
    act(() => result.current.play());
    expect(queue).toHaveLength(0);
  });
});
