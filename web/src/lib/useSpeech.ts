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

export function useSpeech(text: string | null): Speech {
  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance === 'function';

  const sentences = useMemo(() => (text ? toSentences(text) : []), [text]);
  const [current, setCurrent] = useState(-1);
  // The utterance callbacks fire after cancel() too; this tells them to shut up.
  const cancelled = useRef(false);

  const stop = useCallback(() => {
    if (!supported) return;
    cancelled.current = true;
    window.speechSynthesis.cancel();
    setCurrent(-1);
  }, [supported]);

  // The speech queue belongs to the tab, not to this component: without this
  // a story keeps talking after the reader navigates away.
  useEffect(() => stop, [stop]);

  const play = useCallback(() => {
    if (!supported || sentences.length === 0) return;
    window.speechSynthesis.cancel();
    cancelled.current = false;

    sentences.forEach((sentence, index) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.onstart = () => {
        if (!cancelled.current) setCurrent(index);
      };
      utterance.onend = () => {
        if (!cancelled.current && index === sentences.length - 1) setCurrent(-1);
      };
      window.speechSynthesis.speak(utterance);
    });
  }, [supported, sentences]);

  return { supported, speaking: current >= 0, current, sentences, play, stop };
}
