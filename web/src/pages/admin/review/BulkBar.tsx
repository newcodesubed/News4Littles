import { X } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { BulkResult } from '../../../admin/types';

/**
 * The bar that appears once rows are selected, plus the report of what a bulk
 * action left out (§4.2: bulk approve excludes skip-young unless asked).
 */
export function BulkBar({
  selectedCount,
  flaggedCount,
  includeFlagged,
  onIncludeFlaggedChange,
  onAction,
  onClear,
}: {
  selectedCount: number;
  flaggedCount: number;
  includeFlagged: boolean;
  onIncludeFlaggedChange: (include: boolean) => void;
  onAction: (action: 'approve' | 'reject' | 'delete') => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) return null;

  return (
    <div className="mt-4 rounded-3xl border-2 border-primary bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-bold">{selectedCount} selected</span>
        <Button onClick={() => onAction('approve')}>Approve</Button>
        <Button variant="outline" onClick={() => onAction('reject')}>Reject</Button>
        <Button variant="danger" onClick={() => onAction('delete')}>Delete</Button>
        <Button variant="ghost" className="ml-auto text-muted-foreground" onClick={onClear}>
          Clear selection
        </Button>
      </div>

      {flaggedCount > 0 && (
        <label className="mt-3 flex items-start gap-2 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
          <input type="checkbox" checked={includeFlagged} className="mt-0.5"
            onChange={(e) => onIncludeFlaggedChange(e.target.checked)} />
          <span>
            {flaggedCount} selected {flaggedCount === 1 ? 'story is' : 'stories are'}{' '}
            <strong>skip-young</strong>. They will be left out of Approve unless you tick this box.
          </span>
        </label>
      )}
    </div>
  );
}

/** Requirement 13: say plainly which articles a bulk action skipped. */
export function SkippedReport({
  skipped,
  onDismiss,
}: {
  skipped: BulkResult['skipped'];
  onDismiss: () => void;
}) {
  if (skipped.length === 0) return null;

  return (
    <div className="mt-4 rounded-3xl border-2 border-amber-400 bg-surface-sun p-4" role="alert">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold">{skipped.length} article(s) were skipped</p>
          <ul className="mt-1 text-sm">
            {skipped.map((entry) => (
              <li key={entry.id}>
                <code className="text-xs">{entry.id.slice(0, 8)}…</code> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
        <button onClick={onDismiss} aria-label="Dismiss" className="rounded-full p-1.5 hover:bg-background/50">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
