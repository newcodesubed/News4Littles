import type { Safety } from './types';

/** "Today · Saturday, August 15" — the hero date line (PRD §3.2). */
export function todayLine(date = new Date()): string {
  return `Today · ${date.toLocaleDateString('en-GB', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })}`;
}

/**
 * Category badge colours. Categories are free text in the database, so unknown
 * values fall back to a neutral style rather than breaking the layout.
 */
const CATEGORY_STYLES: Record<string, string> = {
  environment: 'bg-emerald-100 text-emerald-800',
  science: 'bg-violet-100 text-violet-800',
  world: 'bg-sky-100 text-sky-800',
  sports: 'bg-orange-100 text-orange-800',
  'good news': 'bg-rose-100 text-rose-800',
};

export function categoryStyle(category: string): string {
  return CATEGORY_STYLES[category.toLowerCase()] ?? 'bg-slate-100 text-slate-700';
}

/**
 * Safety badge presentation. 'calm' has an entry for completeness, but the UI
 * does not render a badge for it — see SafetyBadge.
 */
export const SAFETY_LABELS: Record<Safety, string> = {
  calm: 'Calm',
  'adult-nearby': 'Grown-up nearby',
  'skip-young': 'Older readers',
};

export const SAFETY_STYLES: Record<Safety, string> = {
  calm: 'bg-emerald-100 text-emerald-800',
  'adult-nearby': 'bg-amber-100 text-amber-900',
  'skip-young': 'bg-rose-100 text-rose-900',
};
