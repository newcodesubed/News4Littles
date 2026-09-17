import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Playing a story the server has read aloud for us.
 *
 * This replaces the browser's own SpeechSynthesis voice. That voice was free
 * and offline, but it is whatever the reader's operating system happens to
 * ship, which for a product read by children is not a decision worth leaving
 * to chance. The server now synthesises the audio through a configured
 * provider and caches it, so every child hears the same reviewed script in the
 * same voice.
 *
 * Which provider that is, is not this file's business — it asks the API for a
 * URL and plays what comes back.
 *
 * DELIBERATELY SIMPLE FOR NOW: one audio file per story, played straight
 * through. The sentence-by-sentence read-along highlight the old hook gave us
 * is not here yet; it comes back once this is proven end to end, which is why
 * `sentences` is not part of this interface rather than being faked.
 */

export type AudioStatus = 'idle' | 'loading' | 'playing' | 'error';

export interface StoryAudio {
  status: AudioStatus;
  playing: boolean;
  loading: boolean;
  /** A message fit for a child to read, or null. */
  error: string | null;
  play: () => void;
  stop: () => void;
}

/**
 * Whoever is playing right now, so it can be told to stop.
 *
 * Unlike the old speech queue this is not a browser limit — nothing stops two
 * <audio> elements playing at once, which is exactly the problem. Two stories
 * talking over each other is unusable, so one player at a time is enforced
 * here. Module-level because the rule is global, whatever the component tree
 * looks like.
 */
let releasePlayer: (() => void) | null = null;

/** Nothing plays without an <audio> element; jsdom without one is "unsupported". */
const canPlay = typeof window !== 'undefined' && typeof window.Audio === 'function';

export function useStoryAudio(src: string | null): StoryAudio {
  const [status, setStatus] = useState<AudioStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const element = useRef<HTMLAudioElement | null>(null);

  /** Stop and let go, without disturbing whoever plays next. */
  const release = useCallback(() => {
    if (releasePlayer === release) releasePlayer = null;
    const audio = element.current;
    if (audio) {
      audio.pause();
      // Back to the start, so pressing play again replays the story rather
      // than resuming a story the child has stopped listening to.
      audio.currentTime = 0;
    }
    setStatus('idle');
  }, []);

  const stop = useCallback(() => {
    setError(null);
    release();
  }, [release]);

  /**
   * The element outlives a render, but it must not outlive the page and it
   * must not outlive its own story.
   *
   * Both cases are the same cleanup. Navigating away unmounts, and moving the
   * reading-age slider swaps the src for a different version of the story —
   * and an element that is merely dropped keeps playing, with nothing left
   * holding a reference to stop it.
   */
  useEffect(() => {
    return () => {
      release();
      element.current = null;
      setError(null);
    };
  }, [src, release]);

  const play = useCallback(() => {
    if (!canPlay || !src) return;

    // Take the floor from whoever has it. They are told directly rather than
    // left to notice, because a paused element reports nothing.
    releasePlayer?.();
    releasePlayer = release;

    const audio = element.current ?? new Audio(src);
    element.current = audio;

    // The first listener of a story waits for the provider to synthesise it,
    // which is seconds, not milliseconds — so loading is a real state with a
    // real spinner, not a flicker.
    setStatus('loading');
    setError(null);

    audio.onplaying = () => setStatus('playing');
    audio.onended = () => release();
    // Fires for a 404, a 502 from the provider, and a 503 when speech is
    // switched off. The status code is not readable from here; a child does
    // not need it, and the network tab has it for whoever does.
    audio.onerror = () => {
      release();
      setStatus('error');
      setError('This story could not be read aloud right now.');
      // A failed element will not recover on a retry; the next play() builds
      // a fresh one, which re-requests the audio.
      element.current = null;
    };

    // Autoplay policy and load failures both land here. A rejection after a
    // real click is almost always the latter.
    void audio.play().catch(() => {
      release();
      setStatus('error');
      setError('This story could not be read aloud right now.');
      element.current = null;
    });
  }, [src, release]);

  return {
    status,
    playing: status === 'playing',
    loading: status === 'loading',
    error,
    play,
    stop,
  };
}
