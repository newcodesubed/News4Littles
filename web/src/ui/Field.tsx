import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * Form controls. The input class string was declared as `const field = '…'` in
 * three separate files and inlined in several more.
 */
export const FIELD_CLASS = 'w-full rounded-xl border border-border bg-background px-4 py-2.5';
export const FIELD_CLASS_COMPACT = 'rounded-xl border border-border bg-background px-3 py-2';

/**
 * A label wrapping its control. `hint` sits OUTSIDE the label element on
 * purpose: inside, it becomes part of the control's accessible name, so
 * "Article text" would read as "Article text 0 words" to a screen reader.
 */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block">
        <span className="text-sm font-bold">{label}</span>
        {children}
      </label>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const TextInput = ({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={`mt-1 ${FIELD_CLASS} ${className}`} />
);

export const TextArea = ({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={`mt-1 ${FIELD_CLASS} ${className}`} />
);

export const Select = ({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={`mt-1 ${FIELD_CLASS} ${className}`} />
);

/** The on/off switch used for sources and settings toggles. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
        checked ? 'bg-primary' : 'bg-input'
      }`}
    >
      <span
        className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
