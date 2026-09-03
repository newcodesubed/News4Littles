import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Public settings (PRD §3.6). Client-side only — §2.2 rules out user accounts,
 * so there is nothing to persist server-side.
 *
 * Kept in context rather than component state because the values are read on
 * more than one route (the reading-age badge on Home, the toggles on Settings).
 * Mirrored into localStorage so a refresh doesn't reset the reader's choices.
 */

export const MIN_AGE = 5;
export const MAX_AGE = 14;
export const DEFAULT_AGE = 6; // §3.6

const STORAGE_KEY = 'news4littles.settings';

interface StoredSettings {
  readingAge: number;
  /**
   * Sources the reader has switched OFF. Storing the exclusions (rather than
   * the inclusions) means a newly added source is visible by default instead of
   * silently hidden.
   */
  disabledSources: string[];
}

interface SettingsValue extends StoredSettings {
  setReadingAge: (age: number) => void;
  toggleSource: (sourceName: string) => void;
  isSourceEnabled: (sourceName: string) => boolean;
}

const SettingsContext = createContext<SettingsValue | null>(null);

function readStored(): StoredSettings {
  const fallback: StoredSettings = { readingAge: DEFAULT_AGE, disabledSources: [] };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    const age = Number(parsed.readingAge);

    return {
      readingAge: Number.isInteger(age) && age >= MIN_AGE && age <= MAX_AGE ? age : DEFAULT_AGE,
      disabledSources: Array.isArray(parsed.disabledSources)
        ? parsed.disabledSources.filter((s): s is string => typeof s === 'string')
        : [],
    };
  } catch {
    // Private browsing, cleared storage, or corrupt JSON — start fresh.
    return fallback;
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<StoredSettings>(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable; settings still work for this session.
    }
  }, [settings]);

  const setReadingAge = useCallback((age: number) => {
    setSettings((current) => ({
      ...current,
      readingAge: Math.min(MAX_AGE, Math.max(MIN_AGE, Math.round(age))),
    }));
  }, []);

  const toggleSource = useCallback((sourceName: string) => {
    setSettings((current) => ({
      ...current,
      disabledSources: current.disabledSources.includes(sourceName)
        ? current.disabledSources.filter((name) => name !== sourceName)
        : [...current.disabledSources, sourceName],
    }));
  }, []);

  const value = useMemo<SettingsValue>(
    () => ({
      ...settings,
      setReadingAge,
      toggleSource,
      isSourceEnabled: (sourceName: string) => !settings.disabledSources.includes(sourceName),
    }),
    [settings, setReadingAge, toggleSource],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings must be used inside a SettingsProvider.');
  return value;
}
