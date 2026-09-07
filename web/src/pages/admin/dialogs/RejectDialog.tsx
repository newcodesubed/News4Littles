import { useState } from 'react';
import type { AdminArticle } from '../../../admin/types';
import { Button } from '../../../ui/Button';
import { FIELD_CLASS } from '../../../ui/Field';
import { Modal } from './Modal';

/** §4.2: reject requires an optional free-text reason before confirming. */
export function RejectDialog({
  article,
  onCancel,
  onConfirm,
}: {
  article: AdminArticle;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <Modal title="Reject this story" onClose={onCancel}>
      <p className="font-bold">{article.kidHeadline}</p>
      <p className="mt-1 text-sm text-muted-foreground">{article.summary}</p>

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
