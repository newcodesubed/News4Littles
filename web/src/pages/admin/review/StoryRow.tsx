import { Eye, ExternalLink, FlaskConical, Loader2, Pencil, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CategoryBadge, SafetyBadge } from '../../../components/Badges';
import { Button } from '../../../ui/Button';
import type { AdminStory } from '../../../admin/types';
import type { PendingAction, RowActions } from './ArticleRow';

const STATUS_STYLE: Record<string, string> = {
  pending_review: 'bg-surface-sun text-amber-800',
  published: 'bg-safety-calm/15 text-safety-calm',
  rejected: 'bg-destructive/10 text-destructive',
};

/**
 * One queue row per story (§5) — a story being one raw article's age versions.
 *
 * Deliberately the same layout, labels and action set as the single-version row
 * it replaced: the wording ("Re-review", "View") and the disabled-not-hidden
 * Delete were chosen for this product, and grouping is no reason to relearn them.
 *
 * Two things are story-level rather than version-level:
 *  - the safety badge shows the STRICTEST verdict across versions, because
 *    every button here acts on all of them. Age 14 reading 'calm' while age 5
 *    is 'skip-young' would hide exactly what the editor needs to see.
 *  - Publish says "Publish all" when there is more than one version, because
 *    it publishes every age at once.
 *
 * The headline and summary come from the youngest version, which is the
 * strictest reading level and the one worth showing in a list.
 */
export function StoryRow({
  story,
  selected,
  onSelectedChange,
  actions,
  pending = null,
  locked = false,
}: {
  story: AdminStory;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  actions: RowActions;
  pending?: PendingAction;
  /** True while any action anywhere in the queue is running. */
  locked?: boolean;
}) {
  const icon = (action: PendingAction, fallback: React.ReactNode) =>
    pending === action ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : fallback;

  const youngest = story.versions[0];
  const ages = story.versions.map((version) => version.ageTarget);
  // "Publish all" earns its word only when there is more than one version;
  // "Publish all" on a single-version story is just noise.
  const many = story.versions.length > 1;
  const ageRange = ages.length === 1 ? `Age ${ages[0]}` : `Ages ${Math.min(...ages)}–${Math.max(...ages)}`;

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex flex-wrap items-start gap-3">
        <input
          type="checkbox"
          aria-label={`Select ${story.kidHeadline}`}
          checked={selected}
          onChange={(e) => onSelectedChange(e.target.checked)}
          className="mt-1.5"
        />

        <div className="flex-1 min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <CategoryBadge category={story.category} />
            <SafetyBadge safety={story.safety} />
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_STYLE[story.status]}`}>
              {story.status.replace('_', ' ')}
            </span>
            <span className="text-xs font-semibold text-muted-foreground">
              {story.versions.length} reading age{story.versions.length === 1 ? '' : 's'} · {ageRange}
              {' · '}{youngest.sourceName}
            </span>
            {story.versions.some((version) => version.editedByHuman) && (
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-bold">edited by a person</span>
            )}
          </div>

          {/* The headline is the natural way to open the story. */}
          <h3 className="font-display text-xl leading-tight">
            <button onClick={actions.onView} className="text-left hover:text-primary">
              {story.kidHeadline}
            </button>
          </h3>
          <p className="mt-1 line-clamp-2 text-sm text-foreground/70">{youngest.summary}</p>

          <p className="mt-2 text-xs text-muted-foreground">
            Original: {story.originalHeadline}{' '}
            <a href={youngest.sourceUrl} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              open <ExternalLink className="w-3 h-3" />
            </a>
          </p>

          <p className="mt-1 text-xs text-muted-foreground">
            Created {new Date(story.createdAt).toLocaleString()}
            {youngest.publishedAt && ` · published ${new Date(youngest.publishedAt).toLocaleString()}`}
          </p>

          {youngest.rejectReason && (
            <p className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm">
              <strong>Reject reason:</strong> {youngest.rejectReason}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={actions.onView} disabled={locked}>
            <Eye className="w-3.5 h-3.5" /> View
          </Button>
          {story.status !== 'published' && (
            <Button size="sm" onClick={actions.onPublish} disabled={locked}>
              {icon('publish', null)} {many ? 'Publish all' : 'Publish'}
            </Button>
          )}
          {story.status !== 'rejected' && (
            <Button size="sm" variant="outline" onClick={actions.onReject} disabled={locked}>
              Reject
            </Button>
          )}
          {story.status !== 'pending_review' && (
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
          {/* §7.2: open the sandbox pre-loaded with this story's raw text. */}
          <Link
            to={`/admin/sandbox?articleId=${encodeURIComponent(story.originalId)}&age=${youngest.ageTarget}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-sm font-bold transition hover:bg-muted"
          >
            <FlaskConical className="w-3.5 h-3.5" /> Sandbox
          </Link>
          <Button
            size="sm"
            variant="danger"
            disabled={locked || story.status === 'published'}
            title={story.status === 'published' ? 'Unpublish before deleting' : undefined}
            onClick={actions.onDelete}
          >
            {icon('delete', <Trash2 className="w-3.5 h-3.5" />)} Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
