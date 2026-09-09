import type { ArticleStatus, KidArticle, Safety } from '../lib/types';

/** What /api/admin/articles returns: a KidArticle plus two admin-only extras. */
export interface AdminArticle extends KidArticle {
  sourceId: string;
  originalHeadline: string;
}

/**
 * One story as the grouped review queue shows it (§5): every age version, plus
 * the story-level facts an editor decides on. `safety` is the strictest across
 * versions, because approving the row approves all of them.
 */
export interface AdminStory {
  originalId: string;
  /** Every version, ascending by ageTarget. Never empty. */
  versions: AdminArticle[];
  safety: Safety;
  status: ArticleStatus;
  kidHeadline: string;
  category: string;
  sourceId: string;
  originalHeadline: string;
  createdAt: string;
}

export interface StatusCounts {
  pending_review: number;
  published: number;
  rejected: number;
  total: number;
  /** Raw articles stored but not yet simplified — the fourth tab's badge. */
  waiting: number;
}

/** A raw article waiting for its simplification (no kid fields exist yet). */
export interface WaitingRawArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  headline: string;
  url: string;
  topic: string;
  publishedAt: string | null;
  fetchedAt: string;
  bodyLength: number;
}

/** A background simplification batch, as the status endpoint reports it. */
export interface SimplifyJob {
  id: string;
  startedAt: string;
  finishedAt?: string;
  rawIds: string[];
  done: number;
  running: boolean;
  report: {
    simplified: { rawId: string; kidHeadline: string }[];
    failures: { rawId: string; error: string }[];
    skipped: string[];
  };
}

export interface FilterOptions {
  categories: string[];
  sources: { id: string; name: string }[];
  ageTargets: number[];
  safety: string[];
  statuses: string[];
  sortFields: string[];
}

export interface BulkResult {
  action: string;
  applied: string[];
  skipped: { id: string; reason: string }[];
  appliedCount: number;
  skippedCount: number;
}

export interface Filters {
  status: string;
  categories: string[];
  safety: string[];
  flagged: boolean;
  sources: string[];
  ageTargets: string[];
  q: string;
  createdFrom: string;
  createdTo: string;
  sort: string;
  order: 'asc' | 'desc';
}

export const EMPTY_FILTERS: Filters = {
  status: 'pending_review',
  categories: [],
  safety: [],
  flagged: false,
  sources: [],
  ageTargets: [],
  q: '',
  createdFrom: '',
  createdTo: '',
  sort: 'createdAt',
  order: 'desc',
};

export function toQueryString(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  for (const value of filters.categories) params.append('category', value);
  for (const value of filters.sources) params.append('source', value);
  for (const value of filters.ageTargets) params.append('ageTarget', value);

  // The flagged shortcut replaces any explicit safety selection (§4.2).
  if (filters.flagged) params.set('flagged', 'true');
  else for (const value of filters.safety) params.append('safety', value);

  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
  // An end date is inclusive of that whole day.
  if (filters.createdTo) params.set('createdTo', `${filters.createdTo}T23:59:59.999Z`);
  params.set('sort', filters.sort);
  params.set('order', filters.order);

  return `?${params.toString()}`;
}
