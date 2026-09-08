import type { ReactNode } from 'react';
import { Button } from '../../../ui/Button';
import { Modal } from './Modal';

/**
 * In-app confirmation, replacing window.confirm.
 *
 * The browser dialog is unstyled, cannot explain consequences properly, and
 * looks like a security warning rather than part of the product.
 */
export interface Confirmation {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'normal';
  onConfirm: () => void;
}

export function ConfirmDialog({
  confirmation,
  onCancel,
}: {
  confirmation: Confirmation;
  onCancel: () => void;
}) {
  const danger = confirmation.tone === 'danger';

  return (
    <Modal title={confirmation.title} onClose={onCancel}>
      <div className="text-sm text-foreground/80">{confirmation.body}</div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" size="lg" onClick={onCancel} autoFocus>
          Cancel
        </Button>
        <Button
          size="lg"
          onClick={() => {
            // The caller decides what happens; this only closes and reports.
            onCancel();
            confirmation.onConfirm();
          }}
          className={danger ? 'bg-destructive text-white shadow-none hover:bg-destructive/90' : ''}
        >
          {confirmation.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
