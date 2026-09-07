import type { ReactNode } from 'react';

/** The card treatment used across admin and public pages. */
export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-3xl border border-border bg-card p-6 shadow-soft ${className}`}>
      {children}
    </div>
  );
}

/** A titled card, used for each block on the settings page. */
export function Section({
  title,
  blurb,
  children,
  className = '',
}: {
  title: string;
  blurb?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <h2 className="font-display text-2xl mb-1">{title}</h2>
      {blurb && <p className="text-sm text-muted-foreground mb-4">{blurb}</p>}
      {children}
    </Card>
  );
}

/** A pill: filter chips, removable tags, status labels. */
export function Chip({
  active = false,
  className = '',
  children,
  ...props
}: {
  active?: boolean;
  className?: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground/70 hover:bg-border'
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** A message bar: the outcome of an action, or a standing caution. */
export function Notice({
  tone = 'neutral',
  role = 'status',
  children,
}: {
  tone?: 'neutral' | 'warn';
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-muted',
    warn: 'bg-surface-sun',
  };
  return (
    <p role={role} className={`rounded-2xl px-4 py-3 text-sm font-semibold ${tones[tone]}`}>
      {children}
    </p>
  );
}
