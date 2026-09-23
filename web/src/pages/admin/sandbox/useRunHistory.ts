import { useEffect, useState } from 'react';
import type { HistoryEntry } from './types';

/**
 * §7.3: session run history.
 *
 * Kept in sessionStorage, so it survives leaving the sandbox and a reload but
 * is gone when the tab closes — what "this browser session" promises.
 */
const STORAGE_KEY = 'news4littles.sandboxHistory';

function readStored(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    // Unreadable or unavailable: start empty rather than break the sandbox.
    return [];
  }
}

export function useRunHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>(readStored);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Full or unavailable; the history still works for this page visit.
    }
  }, [history]);

  return [history, setHistory] as const;
}
