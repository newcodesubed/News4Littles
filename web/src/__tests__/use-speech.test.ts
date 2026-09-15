import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSentences, useSpeech } from '../lib/useSpeech';

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
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

  it('clears the highlight when an utterance fails, instead of sticking', () => {
    // Per the spec a cancelled or failed utterance fires `error`, never `end`;
    // Chrome fires `end` anyway, which is why this only broke elsewhere.
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());
    act(() => queue[0].onstart?.());

    act(() => queue[0].onerror?.({ error: 'synthesis-failed' }));

    expect(result.current.current).toBe(-1);
    expect(result.current.speaking).toBe(false);
  });

  it('does not cancel the tab queue when it was the one interrupted', () => {
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak: (u: FakeUtterance) => queue.push(u), cancel });
    const { result } = renderHook(() => useSpeech('One. Two.'));
    act(() => result.current.play());
    act(() => queue[0].onstart?.());
    cancel.mockClear();

    act(() => queue[0].onerror?.({ error: 'interrupted' }));

    expect(result.current.speaking).toBe(false);
    // The queue belongs to whoever interrupted us; cancelling would cut off
    // their story.
    expect(cancel).not.toHaveBeenCalled();
  });

  it('hands the queue over when a second story starts, leaving no stale Pause', () => {
    // speechSynthesis is one queue per tab, so the second play() cancels the
    // first story's utterances. Without the handover the first is left with a
    // highlighted sentence and a Pause button that stops the SECOND story.
    const first = renderHook(() => useSpeech('One. Two.'));
    const second = renderHook(() => useSpeech('Three. Four.'));
    act(() => first.result.current.play());
    act(() => queue[0].onstart?.());
    expect(first.result.current.speaking).toBe(true);

    act(() => second.result.current.play());
    act(() => queue[0].onstart?.());

    expect(first.result.current.speaking).toBe(false);
    expect(first.result.current.current).toBe(-1);
    expect(second.result.current.speaking).toBe(true);
    expect(queue.map((u) => u.text)).toEqual(['Three.', 'Four.']);
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
