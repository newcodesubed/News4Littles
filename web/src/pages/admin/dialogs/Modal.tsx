import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Without `onClose` the dialog has no X and ignores backdrop clicks and
 * Escape, for one whose only ways out are its own buttons.
 */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/40 p-4 py-10"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div className={`w-full ${wide ? 'max-w-5xl' : 'max-w-lg'} rounded-3xl bg-card shadow-card border border-border`}>
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="font-display text-xl">{title}</h2>
          {onClose && (
            <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 hover:bg-muted">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
