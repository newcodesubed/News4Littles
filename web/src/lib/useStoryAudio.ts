import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Playing a story the server has read aloud for us.
 *
 * Replaces the browser's own SpeechSynthesis voice, which was whatever the
 * reader's operating system happened to ship — not a decision worth leaving to
 * chance for a product read by children. Which provider speaks is not this
 * file's business: it asks the API for a URL and plays what comes back.
 *
 * One audio file per story, played straight through. The sentence-by-sentence
 * read-along highlight comes back once timings travel with the audio.
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

const CANNOT_PLAY = 'This story could not be read aloud right now.';

/**
 * Whoever is playing right now, so it can be told to stop. Nothing in the
 * browser stops two <audio> elements playing at once, which is the problem —
 * one player at a time is enforced here, module-level because the rule is
 * global whatever the component tree looks like.
 */
let releasePlayer: (() => void) | null = null;

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
      // Rewound, so play starts the story over rather than resuming one the
      // child chose to stop.
      audio.currentTime = 0;
    }
    setStatus('idle');
  }, []);

  /** A failed element never recovers; the next play() builds a fresh one. */
  const fail = useCallback(() => {
    release();
    setStatus('error');
    setError(CANNOT_PLAY);
    element.current = null;
  }, [release]);

  const stop = useCallback(() => {
    setError(null);
    release();
  }, [release]);

  /**
   * Navigating away unmounts, and moving the reading-age slider swaps the src
   * for a different version — either way the old element must be stopped, not
   * merely dropped, or it keeps playing with nothing left to stop it.
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

    // Told directly rather than left to notice, because a paused element
    // reports nothing.
    releasePlayer?.();
    releasePlayer = release;

    const audio = element.current ?? new Audio(src);
    element.current = audio;

    // The first listener waits seconds for the provider, so loading is a real
    // state with a real spinner, not a flicker.
    setStatus('loading');
    setError(null);

    audio.onplaying = () => setStatus('playing');
    audio.onended = () => release();
    // Fires alike for a 404, a 502 from the provider and a 503 when speech is
    // off. The status code is not readable here; the network tab has it.
    audio.onerror = fail;
    // Autoplay policy and load failures both land here.
    void audio.play().catch(fail);
  }, [src, release, fail]);

  return {
    status,
    playing: status === 'playing',
    loading: status === 'loading',
    error,
    play,
    stop,
  };
}
