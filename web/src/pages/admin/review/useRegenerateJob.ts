import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../admin/AdminAuthContext';
import type { RegenerateJob } from '../../../admin/types';
import { ageBandLabel } from '../../../lib/ageBands';

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

  /**
   * Adopt whatever preview the server is already holding, once, on mount.
   *
   * The job lives on the server; only this hook's state knew about it, and that
   * state dies when AdminReview unmounts. So leaving the queue and coming back
   * used to strand a running job — invisible here, while a second Regenerate
   * got a 409 — and strand a finished preview whose model calls were
   * already paid for. Asking once costs one request and hands both back.
   */
  useEffect(() => {
    void (async () => {
      try {
        const res = await adminFetch('/api/admin/articles/regenerate/status');
        if (!res.ok) return;

        const body = (await res.json()) as { running: boolean; job: RegenerateJob | null };
        // A failed or already-applied job is finished business, not a preview
        // waiting for a decision.
        if (body.job && !body.job.error && !body.job.appliedAges) setJob(body.job);
      } catch {
        // Nothing to adopt; the editor can still start a fresh one.
      }
    })();
  }, [adminFetch]);

  /** Polls while it runs: three model calls is tens of seconds, so the row cannot just wait. */
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
          // Close the dialog on this path too: it sits under Modal's overlay,
          // so leaving `job` set would hide the notice behind it and make a
          // 409/404/400 apply look like the click did nothing. Nothing was
          // written, so the queue is not reloaded here.
          setJob(null);
          setNotice(`⚠ ${body.error ?? 'Could not apply the regenerated versions.'}`);
          return;
        }
        setJob(null);
        setNotice(`Applied to ${ages.length} version(s): ${ages.map((age) => ageBandLabel(age).toLowerCase()).join(', ')}.`);
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
