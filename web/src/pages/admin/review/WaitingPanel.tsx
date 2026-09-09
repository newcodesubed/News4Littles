import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useAdminAuth } from '../../../admin/AdminAuthContext';
import { ErrorState, LoadingState } from '../../../components/States';
import { Button } from '../../../ui/Button';
import { Select, TextInput } from '../../../ui/Field';
import { Notice } from '../../../ui/Surface';
import type { SimplifyJob, WaitingRawArticle } from '../../../admin/types';

const POLL_MS = 2000;
/** One request covers the realistic backlog; the API caps at 200 regardless. */
const PAGE_SIZE = 200;
/** Below this, a feed item is probably a stub rather than a story. */
const STUB_LENGTH = 200;

/**
 * The review queue's "Not yet simplified" tab.
 *
 * A scrape stores every article it finds but only simplifies
 * app_settings.simplifyBudget of them, so these are the leftovers: real stories
 * with no kid version yet, costing nothing until an editor asks for one.
 *
 * Owns its own loading, selection and polling. The queue's own state is all
 * about kid articles, and threading a differently-shaped tab through it would
 * leave four pieces of state meaning different things depending on the tab.
 */
export function WaitingPanel({
  sources, onSimplified,
}: {
  sources: { id: string; name: string }[];
  onSimplified: () => Promise<void> | void;
}) {
  const { adminFetch } = useAdminAuth();

  const [rows, setRows] = useState<WaitingRawArticle[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<SimplifyJob | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (sourceId) params.set('source', sourceId);

      const res = await adminFetch(`/api/admin/raw-articles/waiting?${params.toString()}`);
      if (!res.ok) throw new Error('Could not load the backlog.');

      const body = (await res.json()) as { articles: WaitingRawArticle[]; total: number };
      setRows(body.articles);
      setTotal(body.total);
      setSelected(new Set());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load the backlog.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch, sourceId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Polls while a batch runs. Fifteen articles is a minute of model calls, so
   * the request that starts it returns immediately and this watches instead.
   */
  useEffect(() => {
    if (!job?.running) return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await adminFetch('/api/admin/raw-articles/simplify/status');
          if (!res.ok) return;

          const body = (await res.json()) as { running: boolean; job: SimplifyJob | null };
          setJob(body.job);
          if (body.running || !body.job) return;

          const done = body.job.report.simplified.length;
          const failed = body.job.report.failures.length;
          setNotice(
            `${done} article(s) simplified and waiting in Pending review` +
              (failed > 0 ? `, ${failed} could not be simplified and are still here.` : '.'),
          );
          await load();
          await onSimplified();
        } catch {
          // A dropped poll is retried on the next tick.
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [job?.running, adminFetch, load, onSimplified]);

  async function simplify(ids: string[]) {
    setNotice(null);
    try {
      const res = await adminFetch('/api/admin/raw-articles/simplify', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(`⚠ ${body.error ?? 'Could not start simplifying.'}`);
        return;
      }
      setJob(((await res.json()) as { job: SimplifyJob }).job);
    } catch {
      setNotice('⚠ Could not reach the server. Check it is running, then try again.');
    }
  }

  // Filtered in the browser: one page covers the backlog, and this keeps the
  // endpoint to one query parameter.
  const visible = search.trim()
    ? rows.filter((row) => row.headline.toLowerCase().includes(search.trim().toLowerCase()))
    : rows;

  const running = job?.running ?? false;
  const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.id));

  return (
    <div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-bold">Source</span>
          <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>{source.name}</option>
            ))}
          </Select>
        </label>
        <label className="block flex-1 min-w-48">
          <span className="text-sm font-bold">Search headlines</span>
          <TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="reef" />
        </label>
      </div>

      <p className="mt-3 max-w-prose text-sm text-muted-foreground">
        Stories a scrape stored but did not simplify. They cost nothing while they wait.
        Simplifying one sends it to the model and puts it in Pending review.
      </p>

      {notice && <div className="mt-4"><Notice>{notice}</Notice></div>}

      {running && job && (
        <div className="mt-4">
          <Notice>
            Simplifying {job.done} of {job.rawIds.length}… this takes a few seconds each.
          </Notice>
        </div>
      )}

      <div className="mt-5">
        {loading && <LoadingState label="Loading the backlog…" />}
        {error && !loading && <ErrorState message={error} />}

        {!loading && !error && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-3">
              <label className="flex items-center gap-2 text-sm font-bold">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={visible.length === 0 || running}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(visible.map((row) => row.id)) : new Set())
                  }
                />
                Select all {visible.length > 0 && `(${visible.length} shown)`}
              </label>

              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">{total} waiting</span>
                <Button
                  size="sm"
                  disabled={selected.size === 0 || running}
                  onClick={() => void simplify([...selected])}
                >
                  <Sparkles className="w-3.5 h-3.5" /> Simplify {selected.size} selected
                </Button>
              </div>
            </div>

            {visible.length === 0 ? (
              <p className="rounded-3xl border border-border bg-card px-6 py-14 text-center text-muted-foreground">
                Nothing is waiting. Every stored article has been simplified.
              </p>
            ) : (
              <div className="space-y-3">
                {visible.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3"
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.headline}`}
                      checked={selected.has(row.id)}
                      disabled={running}
                      onChange={(e) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        })
                      }
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold">{row.headline}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.sourceName} · {row.topic} ·{' '}
                        {row.publishedAt ? new Date(row.publishedAt).toLocaleString() : 'no date'} ·{' '}
                        {row.bodyLength} characters
                        {row.bodyLength < STUB_LENGTH && (
                          <span className="text-amber-700"> · very short, may be a stub</span>
                        )}
                      </p>
                    </div>

                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm underline hover:no-underline"
                    >
                      Read the original
                    </a>

                    <Button
                      size="sm"
                      variant="outline"
                      disabled={running}
                      onClick={() => void simplify([row.id])}
                    >
                      <Sparkles className="w-3.5 h-3.5" /> Simplify
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
