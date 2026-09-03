import type { ReactNode } from 'react';

export function LoadingState({ label = 'Getting today’s stories…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-ink-soft" role="status">
      <span className="h-8 w-8 animate-spin rounded-full border-3 border-brand-wash border-t-brand" />
      <p className="font-semibold">{label}</p>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-3xl border-2 border-dashed border-paper-deep bg-white/60 px-6 py-14 text-center">
      <p aria-hidden="true" className="text-4xl">
        🌱
      </p>
      <h2 className="mt-3 text-xl font-bold">{title}</h2>
      {children && <p className="mx-auto mt-2 max-w-md text-ink-soft">{children}</p>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-3xl border-2 border-rose-200 bg-rose-50 px-6 py-10 text-center" role="alert">
      <p aria-hidden="true" className="text-4xl">
        🌧️
      </p>
      <h2 className="mt-3 text-xl font-bold text-rose-900">We couldn’t load the news</h2>
      <p className="mx-auto mt-2 max-w-lg text-rose-800">{message}</p>
    </div>
  );
}
