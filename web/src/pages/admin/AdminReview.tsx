import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorState, LoadingState } from '../../components/States';
import { useAdminAuth } from '../../admin/AdminAuthContext';
import { useAdminAction } from '../../admin/useAdminAction';
import { Notice } from '../../ui/Surface';
import {
  EMPTY_FILTERS, toQueryString,
  type AdminArticle, type BulkResult, type Filters, type FilterOptions, type StatusCounts,
} from '../../admin/types';
import {
  ConfirmDialog, EditDialog, RegenerateDialog, RejectDialog, ViewArticleDialog,
  type Confirmation,
} from './dialogs';
import { ArticleRow, type PendingAction } from './review/ArticleRow';
import { BulkBar, SkippedReport } from './review/BulkBar';
import { FilterBar } from './review/FilterBar';
import { WaitingPanel } from './review/WaitingPanel';

const TABS = [
  { key: 'pending_review', label: 'Pending review' },
  { key: 'published', label: 'Published' },
  { key: 'rejected', label: 'Rejected' },
  // Not a kid_articles status — raw articles a scrape stored but did not
  // simplify. It must never reach the article query as a status filter.
  { key: 'waiting', label: 'Not yet simplified' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

type BulkAction = 'approve' | 'reject' | 'delete';

/** /admin/review — PRD §4.2. Loads the queue and wires the pieces together. */
export function AdminReview() {
  const { adminFetch } = useAdminAuth();

  const [tab, setTab] = useState<TabKey>('pending_review');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [articles, setArticles] = useState<AdminArticle[]>([]);
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bulkSkipped, setBulkSkipped] = useState<BulkResult['skipped']>([]);
  const [includeFlagged, setIncludeFlagged] = useState(false);

  const [rejecting, setRejecting] = useState<AdminArticle | null>(null);
  const [editing, setEditing] = useState<AdminArticle | null>(null);
  const [viewing, setViewing] = useState<AdminArticle | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  /** Which row is mid-action, so its button can show a spinner. */
  const [pending, setPending] = useState<{ id: string; action: PendingAction } | null>(null);
  const [regenerating, setRegenerating] = useState<{ current: AdminArticle; generated: AdminArticle } | null>(null);

  const query = useMemo(() => toQueryString(filters), [filters]);

  /** Split out of `load` so the badges still refresh on the backlog tab. */
  const loadCounts = useCallback(async () => {
    try {
      const res = await adminFetch('/api/admin/articles/counts');
      if (res.ok) setCounts((await res.json()) as StatusCounts);
    } catch {
      // The badges are cosmetic; the queue works without them.
    }
  }, [adminFetch]);

  const load = useCallback(async () => {
    // The backlog tab loads its own rows; this query is kid articles only.
    if (tab === 'waiting') {
      await loadCounts();
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const listRes = await adminFetch(`/api/admin/articles${query}`);
      if (!listRes.ok) {
        throw new Error(((await listRes.json()) as { error?: string }).error ?? 'Could not load articles.');
      }
      setArticles(((await listRes.json()) as { articles: AdminArticle[] }).articles);
      await loadCounts();
      setSelected(new Set());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load articles.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch, query, tab, loadCounts]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await adminFetch('/api/admin/articles/filters');
        if (res.ok) setOptions((await res.json()) as FilterOptions);
      } catch {
        // The filter dropdowns are optional; the queue still works without them.
      }
    })();
  }, [adminFetch]);

  const { notice, setNotice, run: act } = useAdminAction(load);

  /** Runs a row action while showing a spinner on the button that started it. */
  const runRowAction = useCallback(
    async (id: string, action: PendingAction, path: string, init: RequestInit, message: string) => {
      setPending({ id, action });
      try {
        await act(path, init, message);
      } finally {
        setPending(null);
      }
    },
    [act],
  );

  async function runBulk(action: BulkAction) {
    const ids = [...selected];
    if (ids.length === 0) return;

    let result: BulkResult;
    try {
      const res = await adminFetch('/api/admin/articles/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids, action, includeFlagged }),
      });
      if (!res.ok) {
        setNotice('⚠ Bulk action failed.');
        return;
      }
      result = (await res.json()) as BulkResult;
    } catch {
      setNotice('⚠ Could not reach the server. Check it is running, then try again.');
      return;
    }

    setBulkSkipped(result.skipped);
    setNotice(`${result.appliedCount} article(s) ${action}d.`);
    await load();
  }

  async function openRegenerate(article: AdminArticle) {
    setNotice(null);
    setPending({ id: article.id, action: 'regenerate' });
    try {
      const res = await adminFetch(`/api/admin/articles/${article.id}/regenerate`, { method: 'POST' });
      if (!res.ok) {
        setNotice('⚠ Could not regenerate.');
        return;
      }
      setRegenerating((await res.json()) as { current: AdminArticle; generated: AdminArticle });
    } catch {
      setNotice('⚠ Could not reach the server. Check it is running, then try again.');
    } finally {
      setPending(null);
    }
  }

  const toggleSelected = (id: string, isSelected: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (isSelected) next.add(id);
      else next.delete(id);
      return next;
    });

  const allSelected = articles.length > 0 && selected.size === articles.length;
  const flaggedSelectedCount = articles.filter((a) => selected.has(a.id) && a.safety === 'skip-young').length;

  return (
    <div className="container max-w-6xl py-10">
      <h1 className="font-display text-4xl mb-1">Review queue</h1>
      <p className="text-muted-foreground mb-6">
        Approve, reject or edit simplified articles before they reach kids. Nothing is published automatically.
      </p>

      {/* §4.2 status tabs with count badges */}
      <div className="flex flex-wrap gap-2 border-b border-border pb-3">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key);
                // Only real statuses go into the article query.
                if (t.key !== 'waiting') setFilters({ ...filters, status: t.key });
              }}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition ${
                active ? 'bg-primary text-primary-foreground' : 'text-foreground/70 hover:bg-muted'
              }`}
            >
              {t.label}
              <span className={`rounded-full px-2 py-0.5 text-xs ${active ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
                {counts ? counts[t.key] : '–'}
              </span>
            </button>
          );
        })}
      </div>

      {tab === 'waiting' ? (
        <WaitingPanel sources={options?.sources ?? []} onSimplified={loadCounts} />
      ) : (
      <>
      <FilterBar filters={filters} options={options} onChange={setFilters} />

      {notice && <div className="mt-4"><Notice>{notice}</Notice></div>}

      <BulkBar
        selectedCount={selected.size}
        flaggedCount={flaggedSelectedCount}
        includeFlagged={includeFlagged}
        onIncludeFlaggedChange={setIncludeFlagged}
        onAction={(action) => {
          if (action !== 'delete') { void runBulk(action); return; }
          // §4.2 delete cannot be undone, so it is always confirmed.
          setConfirming({
            title: `Delete ${selected.size} article${selected.size === 1 ? '' : 's'}?`,
            body: 'They will be removed for good. Published articles in the selection are skipped — unpublish those first.',
            confirmLabel: `Delete ${selected.size}`,
            tone: 'danger',
            onConfirm: () => void runBulk('delete'),
          });
        }}
        onClear={() => setSelected(new Set())}
      />

      <SkippedReport skipped={bulkSkipped} onDismiss={() => setBulkSkipped([])} />

      <div className="mt-5">
        {loading && <LoadingState label="Loading the queue…" />}
        {error && !loading && <ErrorState message={error} />}

        {!loading && !error && (
          <>
            <div className="flex items-center justify-between px-1 pb-3">
              <label className="flex items-center gap-2 text-sm font-bold">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={articles.length === 0}
                  onChange={(e) => setSelected(e.target.checked ? new Set(articles.map((a) => a.id)) : new Set())}
                />
                Select all {articles.length > 0 && `(${articles.length} shown)`}
              </label>
              <span className="text-sm text-muted-foreground">{articles.length} result(s)</span>
            </div>

            {articles.length === 0 ? (
              <p className="rounded-3xl border border-border bg-card px-6 py-14 text-center text-muted-foreground">
                Nothing matches these filters.
              </p>
            ) : (
              <div className="space-y-3">
                {articles.map((article) => (
                  <ArticleRow
                    key={article.id}
                    article={article}
                    selected={selected.has(article.id)}
                    onSelectedChange={(isSelected) => toggleSelected(article.id, isSelected)}
                    pending={pending?.id === article.id ? pending.action : null}
                    locked={pending !== null}
                    actions={{
                      onView: () => setViewing(article),
                      onPublish: () => void runRowAction(article.id, 'publish',
                        `/api/admin/articles/${article.id}/publish`, { method: 'PATCH' }, 'Published.'),
                      onReject: () => setRejecting(article),
                      onUnpublish: () => void runRowAction(article.id, 'unpublish',
                        `/api/admin/articles/${article.id}/unpublish`, { method: 'PATCH' }, 'Moved back to pending review.'),
                      onEdit: () => setEditing(article),
                      onRegenerate: () => void openRegenerate(article),
                      onDelete: () => setConfirming({
                        title: 'Delete this story?',
                        body: (
                          <>
                            <strong>{article.kidHeadline}</strong> will be removed for good. The
                            original article stays, so it can be simplified again later.
                          </>
                        ),
                        confirmLabel: 'Delete',
                        tone: 'danger',
                        onConfirm: () => void runRowAction(article.id, 'delete',
                          `/api/admin/articles/${article.id}`, { method: 'DELETE' }, 'Deleted.'),
                      }),
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      </>
      )}

      {viewing && (
        <ViewArticleDialog
          article={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing); setViewing(null); }}
          onReject={() => { setRejecting(viewing); setViewing(null); }}
          onPublish={() => {
            const { id } = viewing;
            setViewing(null);
            void runRowAction(id, 'publish', `/api/admin/articles/${id}/publish`, { method: 'PATCH' }, 'Published.');
          }}
        />
      )}

      {confirming && (
        <ConfirmDialog confirmation={confirming} onCancel={() => setConfirming(null)} />
      )}

      {rejecting && (
        <RejectDialog
          article={rejecting}
          onCancel={() => setRejecting(null)}
          onConfirm={(reason) => {
            const { id } = rejecting;
            setRejecting(null);
            void runRowAction(id, 'reject', `/api/admin/articles/${id}/reject`,
              { method: 'PATCH', body: JSON.stringify({ reason }) }, 'Rejected.');
          }}
        />
      )}

      {editing && (
        <EditDialog
          article={editing}
          onCancel={() => setEditing(null)}
          onSave={(patch) => {
            const { id } = editing;
            setEditing(null);
            void act(`/api/admin/articles/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Saved — marked as edited by a person.');
          }}
        />
      )}

      {regenerating && (
        <RegenerateDialog
          current={regenerating.current}
          generated={regenerating.generated}
          onDiscard={() => setRegenerating(null)}
          onApply={() => {
            const { id } = regenerating.current;
            setRegenerating(null);
            void act(`/api/admin/articles/${id}/regenerate/apply`, { method: 'POST' }, 'Regenerated version applied.');
          }}
        />
      )}
    </div>
  );
}
