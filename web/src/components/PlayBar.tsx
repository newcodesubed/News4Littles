import { Loader2, Pause, Play } from 'lucide-react';

/** The sunny play bar shared by the episode and each story. */

type Size = 'md' | 'lg';

const SIZES: Record<Size, { bar: string; button: string; icon: string }> = {
  md: { bar: 'p-4 gap-3', button: 'w-11 h-11', icon: 'w-5 h-5' },
  lg: { bar: 'p-5 gap-4', button: 'w-14 h-14', icon: 'w-6 h-6' },
};

export function PlayBar({
  label,
  status,
  progress,
  playing,
  loading,
  disabled = false,
  size = 'lg',
  testId,
  onToggle,
}: {
  label: string;
  status: string;
  progress: number;
  playing: boolean;
  loading: boolean;
  disabled?: boolean;
  size?: Size;
  testId?: string;
  onToggle: () => void;
}) {
  const s = SIZES[size];

  return (
    <div
      className={`group relative bg-gradient-sun rounded-2xl flex items-center transition ${s.bar} ${
        disabled ? 'opacity-80' : 'hover:shadow-pop'
      }`}
    >
      {/* The ::after stretches the button over the whole bar, so any spot on it plays or stops. */}
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-label={label}
        aria-busy={loading}
        className={`${s.button} rounded-full shadow-pop bg-primary text-primary-foreground grid place-items-center shrink-0 transition-colors cursor-pointer group-hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed disabled:group-hover:bg-primary after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring`}
      >
        {loading ? (
          <Loader2 className={`${s.icon} animate-spin`} />
        ) : playing ? (
          <Pause className={s.icon} />
        ) : (
          <Play className={`${s.icon} ml-0.5`} />
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className="h-2 bg-background/50 rounded-full overflow-hidden">
          <div
            data-testid={testId && `${testId}-progress`}
            className="h-full bg-primary rounded-full transition-[width] duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <p
          role="status"
          data-testid={testId && `${testId}-status`}
          className="text-xs text-foreground/70 mt-2 font-semibold"
        >
          {status}
        </p>
      </div>
    </div>
  );
}
