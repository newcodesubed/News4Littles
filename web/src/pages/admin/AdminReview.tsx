import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorState, LoadingState } from '../../components/States';
import { useAdminAuth } from '../../admin/AdminAuthContext';
import { useAdminAction } from '../../admin/useAdminAction';
import { Notice } from '../../ui/Surface';
import {
  EMPTY_FILTERS, toQueryString,
  type AdminArticle, type BulkResult, type Filters, type FilterOptions, type StatusCounts,
} from '../../admin/types';
import { EditDialog, RegenerateDialog, RejectDialog } from './dialogs';
import { ArticleRow } from './review/ArticleRow';
import { BulkBar, SkippedReport } from './review/BulkBar';
import { FilterBar } from './review/FilterBar';

const TABS = [
  { key: 'pending_review', label: 'Pending review' },
  { key: 'published', label: 'Published' },
  { key: 'rejected', label: 'Rejected' },
] as const;

type BulkAction = 'approve' | 'reject' | 'delete';

/** /admin/review — PRD §4.2. Loads the queue and wires the pieces together. */
export function AdminReview() {
  const { adminFetch } = useAdminAuth();

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
  const [regenerating, setRegenerating] = useState<{ current: AdminArticle; generated: AdminArticle } | null>(null);

  const query = useMemo(() => toQueryString(filters), [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, countRes] = await Promise.all([
        adminFetch(`/api/admin/articles${query}`),
        adminFetch('/api/admin/articles/counts'),
      ]);
      if (!listRes.ok) {
        throw new Error(((await listRes.json()) as { error?: string }).error ?? 'Could not load articles.');
      }
      setArticles(((await listRes.json()) as { articles: AdminArticle[] }).articles);
      if (countRes.ok) setCounts((await countRes.json()) as StatusCounts);
      setSelected(new Set());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load articles.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch, query]);

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

  async function runBulk(action: BulkAction) {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (action === 'delete' && !window.confirm(`Delete ${ids.length} article(s)? This cannot be undone.`)) return;

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
    try {
      const res = await adminFetch(`/api/admin/articles/${article.id}/regenerate`, { method: 'POST' });
      if (!res.ok) {
        setNotice('⚠ Could not regenerate.');
        return;
      }
      setRegenerating((await res.json()) as { current: AdminArticle; generated: AdminArticle });
    } catch {
      setNotice('⚠ Could not reach the server. Check it is running, then try again.');
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
        {TABS.map((tab) => {
          const active = filters.status === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setFilters({ ...filters, status: tab.key })}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition ${
                active ? 'bg-primary text-primary-foreground' : 'text-foreground/70 hover:bg-muted'
              }`}
            >
              {tab.label}
              <span className={`rounded-full px-2 py-0.5 text-xs ${active ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
                {counts ? counts[tab.key] : '–'}
              </span>
            </button>
          );
        })}
      </div>

      <FilterBar filters={filters} options={options} onChange={setFilters} />

      {notice && <div className="mt-4"><Notice>{notice}</Notice></div>}

      <BulkBar
        selectedCount={selected.size}
        flaggedCount={flaggedSelectedCount}
        includeFlagged={includeFlagged}
        onIncludeFlaggedChange={setIncludeFlagged}
        onAction={(action) => void runBulk(action)}
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
                    actions={{
                      onPublish: () => void act(`/api/admin/articles/${article.id}/publish`, { method: 'PATCH' }, 'Published.'),
                      onReject: () => setRejecting(article),
                      onUnpublish: () => void act(`/api/admin/articles/${article.id}/unpublish`, { method: 'PATCH' }, 'Moved back to pending review.'),
                      onEdit: () => setEditing(article),
                      onRegenerate: () => void openRegenerate(article),
                      onDelete: () => {
                        if (window.confirm('Delete this article? This cannot be undone.')) {
                          void act(`/api/admin/articles/${article.id}`, { method: 'DELETE' }, 'Deleted.');
                        }
                      },
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {rejecting && (
        <RejectDialog
          article={rejecting}
          onCancel={() => setRejecting(null)}
          onConfirm={(reason) => {
            const { id } = rejecting;
            setRejecting(null);
            void act(`/api/admin/articles/${id}/reject`, { method: 'PATCH', body: JSON.stringify({ reason }) }, 'Rejected.');
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
