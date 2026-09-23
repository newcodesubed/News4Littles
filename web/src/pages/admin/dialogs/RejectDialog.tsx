import { useState } from 'react';
import type { AdminArticle } from '../../../admin/types';
import { Button } from '../../../ui/Button';
import { FIELD_CLASS } from '../../../ui/Field';
import { Modal } from './Modal';

/**
 * §4.2: reject requires an optional free-text reason before confirming.
 * One story names it; a bulk reject passes `count` and stores the same reason
 * on each.
 */
export function RejectDialog({
  article,
  count,
  onCancel,
  onConfirm,
  error = null,
}: {
  article?: AdminArticle;
  count?: number;
  onCancel: () => void;
  /** The dialog stays open, showing `error`, until the caller closes it. */
  onConfirm: (reason: string) => void | Promise<unknown>;
  error?: string | null;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const title = article ? 'Reject this story' : `Reject ${count} ${count === 1 ? 'story' : 'stories'}`;

  return (
    <Modal title={title} onClose={onCancel}>
      {article ? (
        <>
          <p className="font-bold">{article.kidHeadline}</p>
          <p className="mt-1 text-sm text-muted-foreground">{article.summary}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          The same reason is stored on each. Any published story in the selection is taken off the site.
        </p>
      )}

      <label className="mt-5 block">
        <span className="text-sm font-bold">Reason (optional)</span>
        <p className="text-xs text-muted-foreground mb-1">
          Stored on the article, so anyone re-reviewing it later can see why.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          placeholder="e.g. Not really news for kids — corporate finance story."
          className={FIELD_CLASS}
        />
      </label>

      {error && <p role="alert" className="mt-4 text-sm font-bold text-destructive">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="lg"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try { await onConfirm(reason); } finally { setSaving(false); }
          }}
          className="bg-destructive text-white shadow-none hover:bg-destructive/90"
        >
          {saving ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
    </Modal>
  );
}
