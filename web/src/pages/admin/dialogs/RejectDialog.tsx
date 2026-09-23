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
}: {
  article?: AdminArticle;
  count?: number;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
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

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="lg" onClick={() => onConfirm(reason)}
          className="bg-destructive text-white shadow-none hover:bg-destructive/90">
          Reject
        </Button>
      </div>
    </Modal>
  );
}
