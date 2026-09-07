import type { KidArticle } from '../../../lib/types';

export type PromptTarget = 'simplification' | 'guard';

export interface PromptDraft {
  target: PromptTarget;
  age: number | null;
  promptText: string;
  updatedAt: string;
}

export interface PromptVersion {
  id: string;
  target: PromptTarget;
  age: number | null;
  promptText: string;
  version: number;
  promotedBy: string;
  promotedAt: string;
  note: string | null;
}

export interface PromptsPayload {
  simplification: { generic: string; ageOverrides: Record<string, string> };
  guard: { promptText: string; enabled: boolean };
  versions: Record<string, number>;
  drafts: PromptDraft[];
  templateVariables: string[];
  llm: { enabled: boolean; model: string };
  defaultAge: number;
}

export interface RawArticleSummary {
  id: string;
  headline: string;
  sourceName: string;
  topic: string;
  publishedAt: string | null;
  fetchedAt: string;
  bodyLength: number;
}

export interface ValidationReport {
  schemaValid: boolean;
  parseError?: string;
  ageLimit: number;
  longestSentenceWords: number;
  withinAgeLimit: boolean;
  overLongSentences: string[];
}

export interface SandboxRun {
  target: PromptTarget;
  age: number | null;
  engine: 'llm' | 'local-fallback';
  model?: string;
  elapsedMs?: number;
  costUsd?: number;
  fallbackReason?: string;
  article?: KidArticle;
  guardVerdict?: string;
  guardRaw?: string;
  validation?: ValidationReport;
}

export interface TestResult {
  subject: { headline: string; body: string; sourceName: string; category: string };
  draft: SandboxRun;
  production?: SandboxRun;
  usingLocalFallback: boolean;
}

/** §7.3: session run history, kept in memory only. */
export interface HistoryEntry {
  at: string;
  target: PromptTarget;
  age: number | null;
  promptSnapshot: string;
  subjectHeadline: string;
  result: TestResult;
}

/** The key used by the versions summary. */
export const versionKey = (target: PromptTarget, age: number | null): string =>
  age === null ? target : `${target}:${age}`;
