import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, Pencil, RotateCcw, Search, Trash2, Undo2, X } from 'lucide-react';
import { CategoryBadge, SafetyBadge } from '../../components/Badges';
import { ErrorState, LoadingState } from '../../components/States';
import { useAdminAuth } from '../../admin/AdminAuthContext';
import {
  EMPTY_FILTERS,
  toQueryString,
  type AdminArticle,
  type BulkResult,
  type Filters,
  type FilterOptions,
  type StatusCounts,
} from '../../admin/types';
import { EditDialog, RegenerateDialog, RejectDialog } from './dialogs';

const TABS = [
  { key: 'pending_review', label: 'Pending review' },
  { key: 'published', label: 'Published' },
  { key: 'rejected', label: 'Rejected' },
] as const;

const STATUS_STYLE: Record<string, string> = {
  pending_review: 'bg-surface-sun text-amber-800',
  published: 'bg-safety-calm/15 text-safety-calm',
  rejected: 'bg-destructive/10 text-destructive',
};

const SORTS = [
  { value: 'createdAt', label: 'Created' },
  { value: 'publishedAt', label: 'Published' },
  { value: 'readingMinutes', label: 'Reading time' },
  { value: 'ageTarget', label: 'Age target' },
];

/** /admin/review — PRD §4.2. */
export function AdminReview() {
  const { adminFetch } = useAdminAuth();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [articles, setArticles] = useState<AdminArticle[]>([]);
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      if (!listRes.ok) throw new Error(((await listRes.json()) as { error?: string }).error ?? 'Could not load articles.');
      setArticles(((await listRes.json()) as { articles: AdminArticle[] }).articles);
      if (countRes.ok) setCounts((await countRes.json()) as StatusCounts);
      setSelected(new Set());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load articles.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch, query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await adminFetch('/api/admin/articles/filters');
      if (res.ok) setOptions((await res.json()) as FilterOptions);
    })();
  }, [adminFetch]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const toggleIn = (key: 'categories' | 'safety' | 'sources' | 'ageTargets', value: string) =>
    setFilters((current) => ({
      ...current,
      [key]: current[key].includes(value) ? current[key].filter((v) => v !== value) : [...current[key], value],
    }));

  async function act(path: string, init: RequestInit, successMessage: string) {
    setNotice(null);
    const res = await adminFetch(path, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(`⚠ ${body.error ?? `Request failed (${res.status}).`}`);
      return false;
    }
    setNotice(successMessage);
    await load();
    return true;
  }

  async function runBulk(action: 'approve' | 'reject' | 'delete') {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (action === 'delete' && !window.confirm(`Delete ${ids.length} article(s)? This cannot be undone.`)) return;

    const res = await adminFetch('/api/admin/articles/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids, action, includeFlagged }),
    });
    if (!res.ok) {
      setNotice('⚠ Bulk action failed.');
      return;
    }
    const result = (await res.json()) as BulkResult;
    setBulkSkipped(result.skipped);
    setNotice(`${result.appliedCount} article(s) ${action}d.`);
    await load();
  }

  async function openRegenerate(article: AdminArticle) {
    setNotice(null);
    const res = await adminFetch(`/api/admin/articles/${article.id}/regenerate`, { method: 'POST' });
    if (!res.ok) {
      setNotice('⚠ Could not regenerate.');
      return;
    }
    setRegenerating((await res.json()) as { current: AdminArticle; generated: AdminArticle });
  }

  const allSelected = articles.length > 0 && selected.size === articles.length;
  const flaggedSelectedCount = articles.filter((a) => selected.has(a.id) && a.safety === 'skip-young').length;

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-xs font-bold transition ${
      active ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground/70 hover:bg-border'
    }`;

  return (
    <div className="container max-w-6xl py-10">
      <h1 className="font-display text-4xl mb-1">Review queue</h1>
      <p className="text-muted-foreground mb-6">
        Approve, reject or edit simplified articles before they reach kids. Nothing is published automatically.
      </p>

      {/* ── Status tabs with count badges (§4.2) ───────────────────────── */}
      <div className="flex flex-wrap gap-2 border-b border-border pb-3">
        {TABS.map((tab) => {
          const active = filters.status === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => set('status', tab.key)}
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

      {/* ── Filter bar (§4.2) ──────────────────────────────────────────── */}
      <div className="mt-5 rounded-3xl border border-border bg-card p-5 shadow-soft space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative grow min-w-60">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filters.q}
              onChange={(e) => set('q', e.target.value)}
              placeholder="Search kid headline, summary or original headline…"
              aria-label="Search"
              className="w-full rounded-full border border-border bg-background py-2.5 pl-9 pr-4 text-sm"
            />
          </div>

          <label className="flex items-center gap-2 text-sm font-bold">
            Sort
            <select value={filters.sort} onChange={(e) => set('sort', e.target.value)}
              className="rounded-full border border-border bg-background px-3 py-2">
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>

          <button
            onClick={() => set('order', filters.order === 'desc' ? 'asc' : 'desc')}
            className="rounded-full border border-border px-3 py-2 text-sm font-bold hover:bg-muted"
          >
            {filters.order === 'desc' ? 'Newest first ↓' : 'Oldest first ↑'}
          </button>

          <button onClick={() => setFilters({ ...EMPTY_FILTERS, status: filters.status })}
            className="rounded-full px-3 py-2 text-sm font-bold text-muted-foreground hover:bg-muted">
            Clear filters
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground w-16">Safety</span>
          {/* §4.2: one-click "flagged only" = adult-nearby + skip-young */}
          <button
            onClick={() => { set('flagged', !filters.flagged); set('safety', []); }}
            className={`inline-flex items-center gap-1.5 ${chip(filters.flagged)}`}
          >
            <AlertTriangle className="w-3.5 h-3.5" /> Flagged only
          </button>
          {['calm', 'adult-nearby', 'skip-young'].map((value) => (
            <button key={value}
              onClick={() => { set('flagged', false); toggleIn('safety', value); }}
              className={chip(!filters.flagged && filters.safety.includes(value))}>
              {value}
            </button>
          ))}
        </div>

        {options && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground w-16">Category</span>
              {options.categories.map((value) => (
                <button key={value} onClick={() => toggleIn('categories', value)} className={chip(filters.categories.includes(value))}>
                  {value}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground w-16">Source</span>
              {options.sources.map((source) => (
                <button key={source.id} onClick={() => toggleIn('sources', source.id)} className={chip(filters.sources.includes(source.id))}>
                  {source.name}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground w-16">Age</span>
              {options.ageTargets.map((age) => (
                <button key={age} onClick={() => toggleIn('ageTargets', String(age))} className={chip(filters.ageTargets.includes(String(age)))}>
                  {age}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground w-16">Created</span>
          <input type="date" value={filters.createdFrom} onChange={(e) => set('createdFrom', e.target.value)}
            aria-label="Created from" className="rounded-full border border-border bg-background px-3 py-2" />
          <span className="text-muted-foreground">to</span>
          <input type="date" value={filters.createdTo} onChange={(e) => set('createdTo', e.target.value)}
            aria-label="Created to" className="rounded-full border border-border bg-background px-3 py-2" />
        </div>
      </div>

      {notice && (
        <p className="mt-4 rounded-2xl bg-muted px-4 py-3 text-sm font-semibold" role="status">{notice}</p>
      )}

      {/* ── Bulk action bar (§4.2) ─────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="mt-4 rounded-3xl border-2 border-primary bg-card p-4 shadow-card">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-bold">{selected.size} selected</span>
            <button onClick={() => runBulk('approve')} className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">
              Approve
            </button>
            <button onClick={() => runBulk('reject')} className="rounded-full border border-border px-4 py-2 text-sm font-bold hover:bg-muted">
              Reject
            </button>
            <button onClick={() => runBulk('delete')} className="rounded-full px-4 py-2 text-sm font-bold text-destructive hover:bg-muted">
              Delete
            </button>
            <button onClick={() => setSelected(new Set())} className="ml-auto rounded-full px-3 py-2 text-sm font-bold text-muted-foreground hover:bg-muted">
              Clear selection
            </button>
          </div>

          {/* §4.2: bulk approve excludes skip-young unless explicitly included */}
          {flaggedSelectedCount > 0 && (
            <label className="mt-3 flex items-start gap-2 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
              <input type="checkbox" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} className="mt-0.5" />
              <span>
                {flaggedSelectedCount} selected {flaggedSelectedCount === 1 ? 'story is' : 'stories are'}{' '}
                <strong>skip-young</strong>. They will be left out of Approve unless you tick this box.
              </span>
            </label>
          )}
        </div>
      )}

      {/* §4.2 / requirement 13: report what a bulk approve left out */}
      {bulkSkipped.length > 0 && (
        <div className="mt-4 rounded-3xl border-2 border-amber-400 bg-surface-sun p-4" role="alert">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-bold">{bulkSkipped.length} article(s) were skipped</p>
              <ul className="mt-1 text-sm">
                {bulkSkipped.map((s) => (
                  <li key={s.id}>
                    <code className="text-xs">{s.id.slice(0, 8)}…</code> — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
            <button onClick={() => setBulkSkipped([])} aria-label="Dismiss" className="rounded-full p-1.5 hover:bg-background/50">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── List ───────────────────────────────────────────────────────── */}
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
                  onChange={(e) => setSelected(e.target.checked ? new Set(articles.map((a) => a.id)) : new Set())}
                  disabled={articles.length === 0}
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
                  <div key={article.id} className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                    <div className="flex flex-wrap items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${article.kidHeadline}`}
                        checked={selected.has(article.id)}
                        onChange={(e) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (e.target.checked) next.add(article.id);
                            else next.delete(article.id);
                            return next;
                          })
                        }
                        className="mt-1.5"
                      />

                      <div className="flex-1 min-w-0">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <CategoryBadge category={article.category} />
                          <SafetyBadge safety={article.safety} />
                          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_STYLE[article.status]}`}>
                            {article.status.replace('_', ' ')}
                          </span>
                          <span className="text-xs font-semibold text-muted-foreground">
                            Age {article.ageTarget} · {article.readingMinutes} min · {article.sourceName}
                          </span>
                          {article.editedByHuman && (
                            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-bold">edited by a person</span>
                          )}
                        </div>

                        <h3 className="font-display text-xl leading-tight">{article.kidHeadline}</h3>
                        <p className="mt-1 line-clamp-2 text-sm text-foreground/70">{article.summary}</p>

                        <p className="mt-2 text-xs text-muted-foreground">
                          Original: {article.originalHeadline}{' '}
                          <a href={article.sourceUrl} target="_blank" rel="noreferrer"
                            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                            open <ExternalLink className="w-3 h-3" />
                          </a>
                        </p>

                        <p className="mt-1 text-xs text-muted-foreground">
                          Created {new Date(article.createdAt).toLocaleString()}
                          {article.publishedAt && ` · published ${new Date(article.publishedAt).toLocaleString()}`}
                        </p>

                        {article.rejectReason && (
                          <p className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm">
                            <strong>Reject reason:</strong> {article.rejectReason}
                          </p>
                        )}
                      </div>

                      {/* Row actions (§4.2) */}
                      <div className="flex flex-wrap gap-2">
                        {article.status !== 'published' && (
                          <button
                            onClick={() => act(`/api/admin/articles/${article.id}/publish`, { method: 'PATCH' }, 'Published.')}
                            className="rounded-full bg-primary px-3.5 py-2 text-sm font-bold text-primary-foreground">
                            Publish
                          </button>
                        )}
                        {article.status !== 'rejected' && (
                          <button onClick={() => setRejecting(article)}
                            className="rounded-full border border-border px-3.5 py-2 text-sm font-bold hover:bg-muted">
                            Reject
                          </button>
                        )}
                        {article.status !== 'pending_review' && (
                          <button
                            onClick={() => act(`/api/admin/articles/${article.id}/unpublish`, { method: 'PATCH' }, 'Moved back to pending review.')}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-3.5 py-2 text-sm font-bold hover:bg-muted">
                            <Undo2 className="w-3.5 h-3.5" /> Re-review
                          </button>
                        )}
                        <button onClick={() => setEditing(article)}
                          className="inline-flex items-center gap-1 rounded-full border border-border px-3.5 py-2 text-sm font-bold hover:bg-muted">
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                        <button onClick={() => openRegenerate(article)}
                          className="inline-flex items-center gap-1 rounded-full border border-border px-3.5 py-2 text-sm font-bold hover:bg-muted">
                          <RotateCcw className="w-3.5 h-3.5" /> Regenerate
                        </button>
                        <button
                          disabled={article.status === 'published'}
                          title={article.status === 'published' ? 'Unpublish before deleting' : undefined}
                          onClick={() => {
                            if (window.confirm('Delete this article? This cannot be undone.')) {
                              void act(`/api/admin/articles/${article.id}`, { method: 'DELETE' }, 'Deleted.');
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-bold text-destructive hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed">
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </div>
                    </div>
                  </div>
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
            const id = rejecting.id;
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
            const id = editing.id;
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
            const id = regenerating.current.id;
            setRegenerating(null);
            void act(`/api/admin/articles/${id}/regenerate/apply`, { method: 'POST' }, 'Regenerated version applied.');
          }}
        />
      )}
    </div>
  );
}
