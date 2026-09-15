import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Speaking a story with the browser's own voice (SpeechSynthesis) — free, no
 * key, no audio files, and nothing leaves the device.
 *
 * Spoken ONE SENTENCE AT A TIME, which is not a style choice: Chrome silently
 * truncates a single utterance after roughly 15 seconds, so a whole story
 * queued as one utterance stops mid-word. Chunking also gives read-along
 * highlighting for free — the chunk boundaries are ours, whereas word-level
 * `onboundary` events are reliable only in Chrome and Edge.
 */

/** The same sentence rule the server's rule-based simplifier uses. */
export function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export interface Speech {
  supported: boolean;
  speaking: boolean;
  /** Index into `sentences` currently being spoken, or -1. */
  current: number;
  sentences: string[];
  play: () => void;
  stop: () => void;
}

/**
 * Whoever is speaking right now, so it can be told to let go.
 *
 * `speechSynthesis` is ONE queue per tab: pressing play on a second story
 * cancels the first story's remaining utterances. Module-level rather than in a
 * context or a store because the constraint itself is global — the browser
 * allows exactly one speaker per tab, whatever the component tree looks like.
 * Without it the displaced story keeps a highlighted sentence and a Pause
 * button that, when pressed, stops the story that is actually speaking.
 */
let releaseSpeaker: (() => void) | null = null;

export function useSpeech(text: string | null): Speech {
  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance === 'function';

  const sentences = useMemo(() => (text ? toSentences(text) : []), [text]);
  const [current, setCurrent] = useState(-1);
  // The utterance callbacks fire after cancel() too; this tells them to shut up.
  const cancelled = useRef(false);

  /** Give up the queue and the highlight, WITHOUT touching the tab's queue. */
  const release = useCallback(() => {
    cancelled.current = true;
    if (releaseSpeaker === release) releaseSpeaker = null;
    setCurrent(-1);
  }, []);

  const stop = useCallback(() => {
    if (!supported) return;
    release();
    window.speechSynthesis.cancel();
  }, [supported, release]);

  // The speech queue belongs to the tab, not to this component: without this
  // a story keeps talking after the reader navigates away.
  useEffect(() => stop, [stop]);

  const play = useCallback(() => {
    if (!supported || sentences.length === 0) return;
    // The cancel() below takes the queue off whoever holds it, and their
    // utterances may report that in a way we cannot rely on, so they are told
    // first and directly.
    releaseSpeaker?.();
    releaseSpeaker = release;
    window.speechSynthesis.cancel();
    cancelled.current = false;

    sentences.forEach((sentence, index) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.onstart = () => {
        if (!cancelled.current) setCurrent(index);
      };
      utterance.onend = () => {
        if (cancelled.current || index !== sentences.length - 1) return;
        release();
      };
      // A cancelled utterance fires `error`, not `end`, per the spec — Chrome
      // papers over it by firing `end`, which is why only Chrome looked right.
      // A real 'synthesis-failed' arrives the same way. Either leaves the UI
      // stuck mid-story unless it is handled.
      utterance.onerror = (event) => {
        if (cancelled.current) return;
        release();
        // 'canceled'/'interrupted' means the queue is already someone else's:
        // cancelling here would cut off THEIR story. Any other error is ours,
        // and the rest of our sentences go with it.
        if (event?.error !== 'canceled' && event?.error !== 'interrupted') {
          window.speechSynthesis.cancel();
        }
      };
      window.speechSynthesis.speak(utterance);
    });
  }, [supported, sentences, release]);

  return { supported, speaking: current >= 0, current, sentences, play, stop };
}
