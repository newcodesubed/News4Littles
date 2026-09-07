import { useCallback, useState } from 'react';
import { useAdminAuth } from './AdminAuthContext';

/**
 * Running one admin mutation and telling the editor what happened.
 *
 * Every admin page previously repeated the same fetch-then-check-ok block with
 * its own `notice` state — and none of them wrapped the call in try/catch, so
 * if the server was unreachable the request rejected into a floating promise
 * and the button silently did nothing. That is the failure this exists to stop.
 */
export interface AdminActionState {
  /** Message to show the editor: a confirmation, or an error prefixed with a warning. */
  notice: string | null;
  /** True while a request is in flight, so buttons can disable themselves. */
  busy: boolean;
  setNotice: (notice: string | null) => void;
  /**
   * Performs the request. Resolves true on success, false on any failure —
   * never rejects, so callers need no try/catch of their own.
   */
  run: (path: string, init: RequestInit, successMessage: string) => Promise<boolean>;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    // A non-JSON body (a proxy error page, say) still needs a usable message.
    return fallback;
  }
}

export function useAdminAction(onSuccess?: () => Promise<void> | void): AdminActionState {
  const { adminFetch } = useAdminAuth();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (path: string, init: RequestInit, successMessage: string): Promise<boolean> => {
      setNotice(null);
      setBusy(true);

      try {
        const response = await adminFetch(path, init);

        if (!response.ok) {
          setNotice(`⚠ ${await readError(response, `Request failed (${response.status}).`)}`);
          return false;
        }

        setNotice(successMessage);
        await onSuccess?.();
        return true;
      } catch {
        // fetch rejects when the server is unreachable, the connection drops
        // or the request is blocked. Without this the editor saw nothing at all.
        setNotice('⚠ Could not reach the server. Check it is running, then try again.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [adminFetch, onSuccess],
  );

  return { notice, busy, setNotice, run };
}
