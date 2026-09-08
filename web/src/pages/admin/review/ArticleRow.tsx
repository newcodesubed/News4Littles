import { Eye, ExternalLink, FlaskConical, Loader2, Pencil, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CategoryBadge, SafetyBadge } from '../../../components/Badges';
import { Button } from '../../../ui/Button';
import type { AdminArticle } from '../../../admin/types';

const STATUS_STYLE: Record<string, string> = {
  pending_review: 'bg-surface-sun text-amber-800',
  published: 'bg-safety-calm/15 text-safety-calm',
  rejected: 'bg-destructive/10 text-destructive',
};

export interface RowActions {
  onView: () => void;
  onPublish: () => void;
  onReject: () => void;
  onUnpublish: () => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}

/**
 * Which action on this row is in flight, if any. Every button is disabled while
 * one is running: without it, a slow Regenerate looks like nothing happened and
 * invites a second click.
 */
export type PendingAction = 'publish' | 'reject' | 'unpublish' | 'regenerate' | 'delete' | null;

/** One queue row: metadata, the story, and the §4.2 row actions. */
export function ArticleRow({
  article,
  selected,
  onSelectedChange,
  actions,
  pending = null,
  locked = false,
}: {
  article: AdminArticle;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  actions: RowActions;
  pending?: PendingAction;
  /** True while any action anywhere in the queue is running. */
  locked?: boolean;
}) {
  /** A spinner in place of the icon while this action runs. */
  const icon = (action: PendingAction, fallback: React.ReactNode) =>
    pending === action ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : fallback;

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex flex-wrap items-start gap-3">
        <input
          type="checkbox"
          aria-label={`Select ${article.kidHeadline}`}
          checked={selected}
          onChange={(e) => onSelectedChange(e.target.checked)}
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

          {/* The headline is the natural way to open the story. */}
          <h3 className="font-display text-xl leading-tight">
            <button onClick={actions.onView} className="text-left hover:text-primary">
              {article.kidHeadline}
            </button>
          </h3>
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

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={actions.onView} disabled={locked}>
            <Eye className="w-3.5 h-3.5" /> View
          </Button>
          {article.status !== 'published' && (
            <Button size="sm" onClick={actions.onPublish} disabled={locked}>
              {icon('publish', null)} Publish
            </Button>
          )}
          {article.status !== 'rejected' && (
            <Button size="sm" variant="outline" onClick={actions.onReject} disabled={locked}>
              Reject
            </Button>
          )}
          {article.status !== 'pending_review' && (
            <Button size="sm" variant="outline" onClick={actions.onUnpublish} disabled={locked}>
              {icon('unpublish', <Undo2 className="w-3.5 h-3.5" />)} Re-review
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={actions.onEdit} disabled={locked}>
            <Pencil className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button size="sm" variant="outline" onClick={actions.onRegenerate} disabled={locked}>
            {icon('regenerate', <RotateCcw className="w-3.5 h-3.5" />)}
            {pending === 'regenerate' ? 'Regenerating…' : 'Regenerate'}
          </Button>
          {/* §7.2: open the sandbox pre-loaded with this article's raw text. */}
          <Link
            to={`/admin/sandbox?articleId=${encodeURIComponent(article.originalId)}&age=${article.ageTarget}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-sm font-bold transition hover:bg-muted"
          >
            <FlaskConical className="w-3.5 h-3.5" /> Sandbox
          </Link>
          <Button
            size="sm"
            variant="danger"
            disabled={locked || article.status === 'published'}
            title={article.status === 'published' ? 'Unpublish before deleting' : undefined}
            onClick={actions.onDelete}
          >
            {icon('delete', <Trash2 className="w-3.5 h-3.5" />)} Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
