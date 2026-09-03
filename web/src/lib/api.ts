import type { KidArticle } from './types';

/**
 * Base URL of the /server API. Configured in web/.env as VITE_API_BASE_URL —
 * see .env.example. Vite inlines this at build time.
 */
export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'
).replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`);
  } catch {
    // Network-level failure: server down, wrong port, or CORS rejected it.
    throw new ApiError(
      `Could not reach the API at ${API_BASE_URL}. Is the server running (npm run dev in /server)?`,
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = ((await response.json()) as { error?: string }).error ?? '';
    } catch {
      // Body was not JSON; fall through to the generic message.
    }
    throw new ApiError(detail || `Request failed with status ${response.status}.`, response.status);
  }

  return (await response.json()) as T;
}

/** Home and podcast show published stories only (PRD §11.1). */
export function fetchPublishedArticles(): Promise<KidArticle[]> {
  return getJson<KidArticle[]>('/api/articles?status=published');
}

export function fetchArticle(id: string): Promise<KidArticle> {
  return getJson<KidArticle>(`/api/articles/${encodeURIComponent(id)}`);
}
