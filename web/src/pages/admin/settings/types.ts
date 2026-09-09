export interface Source {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  trustLevel: 'high' | 'medium' | 'low';
  parser: string | null;
  lastFetchedAt: string | null;
  lastFetchedItemPublishedAt: string | null;
  articleCount: number;
}

export interface GuardConfig {
  denyList: string[];
  denyListEnabled: boolean;
  promptGuardEnabled: boolean;
  promptGuardText: string;
}

export interface PromptConfig {
  genericPrompt: string;
  ageOverrides: Record<string, string>;
  versions: Record<string, number>;
}

export interface AppSettings {
  defaultAge: number;
  scrapeTimes: string[];
  llmProvider: string | null;
  apiKeyLocation: string;
  /** How many stored articles one scrape run may simplify. 0 disables it. */
  simplifyBudget: number;
}

/** Runs one settings mutation; resolves false if it failed. */
export type Save = (path: string, init: RequestInit, message: string) => Promise<boolean>;

/** §4.4: what one scrape run did. */
export interface ScrapeRun {
  id: string;
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error: string | null;
  itemsInFeed: number;
  inserted: number;
  /** Of what the run stored, how many were simplified. */
  simplified: number;
  /** Age versions written across those stories. */
  versions: number;
  /** This source's raws still waiting when the run finished. */
  leftWaiting: number;
  skippedNotNew: number;
  skippedAlreadyStored: number;
  skippedUnusable: number;
  costUsd: number;
  fallbacks: string[];
  trigger: 'manual' | 'scheduled';
}

export interface ScrapeStatus {
  running: boolean;
  run: {
    id: string;
    startedAt: string;
    finishedAt?: string;
    sourceIds: string[];
    currentSourceId?: string;
    /** Which half of the run is happening. */
    phase: 'fetching' | 'simplifying';
    budget: number;
    simplifiedCount: number;
    results: {
      sourceId: string; sourceName: string; ok: boolean; error?: string;
      inserted: number; leftWaiting: number;
      simplified: { rawId: string; kidHeadline: string; safety: string; engine: string }[];
    }[];
    summary: {
      inserted: number; simplified: number; leftWaiting: number; failed: number; costUsd: number;
    };
  } | null;
  /** The most recent run per source, so the page is useful before any click. */
  lastRuns: Record<string, ScrapeRun>;
}
