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
}

/** Runs one settings mutation; resolves false if it failed. */
export type Save = (path: string, init: RequestInit, message: string) => Promise<boolean>;
