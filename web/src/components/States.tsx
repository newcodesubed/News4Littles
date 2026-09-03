import type { ReactNode } from 'react';

export function LoadingState({ label = 'Getting today’s stories…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground" role="status">
      <span className="h-8 w-8 animate-spin rounded-full border-3 border-muted border-t-primary" />
      <p className="font-semibold">{label}</p>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="bg-card rounded-3xl border border-border shadow-soft px-6 py-14 text-center">
      <h2 className="font-display text-2xl mb-2">{title}</h2>
      {children && <p className="mx-auto max-w-md text-muted-foreground">{children}</p>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="bg-card rounded-3xl border-2 border-destructive/30 shadow-soft px-6 py-12 text-center"
      role="alert"
    >
      <h2 className="font-display text-2xl mb-2">We couldn’t load the news</h2>
      <p className="mx-auto max-w-lg text-muted-foreground">{message}</p>
    </div>
  );
}
