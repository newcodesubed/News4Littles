import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../admin/AdminAuthContext';
import type { RegenerateJob } from '../../../admin/types';

const POLL_MS = 2000;
const OFFLINE = '⚠ Could not reach the server. Check it is running, then try again.';
const LOST = '⚠ The regenerate preview was lost. Try again.';

export interface RegenerateController {
  /** The held preview, running or finished. Null when there is none. */
  job: RegenerateJob | null;
  /** The version id a start request is in flight for, so the row can say so
   *  before the server has answered. */
  startingId: string | null;
  start: (id: string) => Promise<void>;
  apply: (ages: number[]) => Promise<void>;
  discard: () => Promise<void>;
}

/**
 * Starting, watching and applying a story-scoped regeneration (§4.2).
 *
 * Lives outside AdminReview because the page already owns three kinds of async
 * state and this one is a job: it has progress, a lifecycle and a poll. Every
 * message goes through the page's existing notice, so an editor reads one line
 * in one place whatever they just did.
 */
export function useRegenerateJob({
  setNotice,
  onApplied,
}: {
  setNotice: (notice: string | null) => void;
  onApplied: () => Promise<void> | void;
}): RegenerateController {
  const { adminFetch } = useAdminAuth();
  const [job, setJob] = useState<RegenerateJob | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  /** Polls while it runs: ten ages is minutes, so the row cannot just wait. */
  useEffect(() => {
    if (!job?.running) return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await adminFetch('/api/admin/articles/regenerate/status');
          if (!res.ok) return;

          const body = (await res.json()) as { running: boolean; job: RegenerateJob | null };
          // A restart mid-run loses the preview. Nothing was written, so saying
          // so beats spinning forever on a job that no longer exists.
          if (!body.job) { setJob(null); setNotice(LOST); return; }
          if (body.job.error) { setJob(null); setNotice(`⚠ ${body.job.error}`); return; }
          setJob(body.job);
        } catch {
          // A dropped poll is retried on the next tick.
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [job?.running, adminFetch, setNotice]);

  const start = useCallback(
    async (id: string) => {
      setNotice(null);
      setStartingId(id);
      try {
        const res = await adminFetch(`/api/admin/articles/${id}/regenerate`, { method: 'POST' });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setNotice(`⚠ ${body.error ?? 'Could not start regenerating.'}`);
          return;
        }
        setJob(((await res.json()) as { job: RegenerateJob }).job);
      } catch {
        setNotice(OFFLINE);
      } finally {
        setStartingId(null);
      }
    },
    [adminFetch, setNotice],
  );

  const apply = useCallback(
    async (ages: number[]) => {
      if (!job) return;
      setNotice(null);
      try {
        const res = await adminFetch('/api/admin/articles/regenerate/apply', {
          method: 'POST',
          body: JSON.stringify({ jobId: job.id, ages }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setNotice(`⚠ ${body.error ?? 'Could not apply the regenerated versions.'}`);
          return;
        }
        setJob(null);
        setNotice(`Applied to ${ages.length} version(s): age ${ages.join(', ')}.`);
        await onApplied();
      } catch {
        setNotice(OFFLINE);
      }
    },
    [adminFetch, job, onApplied, setNotice],
  );

  const discard = useCallback(async () => {
    setJob(null);
    try {
      await adminFetch('/api/admin/articles/regenerate', { method: 'DELETE' });
    } catch {
      // The preview is already gone from the editor's view, and the server
      // drops its copy the next time a regeneration starts.
    }
  }, [adminFetch]);

  return { job, startingId, start, apply, discard };
}
