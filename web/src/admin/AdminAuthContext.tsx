import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { API_BASE_URL } from '../lib/api';

/**
 * Admin session — PRD §4.1 (single shared account, HTTP Basic Auth).
 *
 * Holds the encoded credential and attaches it to every /api/admin request.
 * Kept in sessionStorage, so it survives a page reload but is gone when the tab
 * closes. Never written to localStorage, and never sent anywhere but this API.
 */
const STORAGE_KEY = 'news4littles.admin';

interface AdminAuthValue {
  credential: string | null;
  isAuthenticated: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const AdminAuthContext = createContext<AdminAuthValue | null>(null);

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export class AdminAuthError extends Error {}

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [credential, setCredential] = useState<string | null>(readStored);

  const signOut = useCallback(() => {
    setCredential(null);
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable; the in-memory state is still cleared.
    }
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const encoded = btoa(`${username}:${password}`);

    // Verify before storing, so a bad password never looks like a session.
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/api/admin/articles/counts`, {
        headers: { Authorization: `Basic ${encoded}` },
      });
    } catch {
      throw new AdminAuthError(`Could not reach the API at ${API_BASE_URL}. Is the server running?`);
    }

    if (response.status === 401) throw new AdminAuthError('Wrong username or password.');
    if (!response.ok) throw new AdminAuthError(`Sign-in failed (${response.status}).`);

    setCredential(encoded);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, encoded);
    } catch {
      // Session still works for this page load.
    }
  }, []);

  const adminFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(credential ? { Authorization: `Basic ${credential}` } : {}),
          ...(init.headers ?? {}),
        },
      });

      // A credential that stopped working must not leave a half-dead session.
      if (response.status === 401) signOut();
      return response;
    },
    [credential, signOut],
  );

  const value = useMemo<AdminAuthValue>(
    () => ({ credential, isAuthenticated: credential !== null, signIn, signOut, adminFetch }),
    [credential, signIn, signOut, adminFetch],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthValue {
  const value = useContext(AdminAuthContext);
  if (!value) throw new Error('useAdminAuth must be used inside an AdminAuthProvider.');
  return value;
}
