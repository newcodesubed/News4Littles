import { Rss } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/States';
import { fetchPublishedArticles } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { MAX_AGE, MIN_AGE, useSettings } from '../settings/SettingsContext';

/**
 * Settings — PRD §3.6 (public settings only: reading age + source toggles).
 *
 * The prototype's Settings page is the admin one (it also carries publication
 * time and per-source trust levels). Those belong to §4.4 and are out of scope
 * here, so this page keeps the prototype's card/slider/switch styling but shows
 * only the two public controls.
 *
 * The source list is derived from published stories because the API exposes no
 * /api/sources endpoint yet.
 */
function Switch({
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
      className={`peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
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

export function Settings() {
  const { readingAge, setReadingAge, isSourceEnabled, toggleSource } = useSettings();
  const state = useAsync(fetchPublishedArticles, []);

  const sources =
    state.status === 'ready'
      ? [...new Set(state.data.map((article) => article.sourceName))].sort()
      : [];

  return (
    <div className="container max-w-3xl py-10">
      <h1 className="font-display text-4xl mb-2">Settings</h1>
      <p className="text-muted-foreground mb-8">
        Choose a reading age and which news sources appear. Saved in this browser only — there are
        no accounts and nothing is sent to us.
      </p>

      <div className="bg-card rounded-3xl border border-border p-6 shadow-soft mb-6">
        <div className="flex items-center justify-between mb-4">
          <span className="font-bold text-base">Default reading age</span>
          <span className="font-display text-2xl text-primary">Age {readingAge}</span>
        </div>

        <input
          type="range"
          min={MIN_AGE}
          max={MAX_AGE}
          step={1}
          value={readingAge}
          onChange={(event) => setReadingAge(Number(event.target.value))}
          aria-label="Default reading age"
          aria-valuetext={`Age ${readingAge}`}
          className="w-full h-2 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />

        <div className="flex justify-between text-xs text-muted-foreground mt-1.5">
          <span>{MIN_AGE}</span>
          <span>6 (default)</span>
          <span>{MAX_AGE}</span>
        </div>
      </div>

      <div className="bg-card rounded-3xl border border-border p-6 shadow-soft">
        <h2 className="font-display text-xl mb-1 inline-flex items-center gap-2">
          <Rss className="w-5 h-5" /> News sources
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Turn a source off to hide its stories from today's news.
        </p>

        {state.status === 'loading' && <LoadingState label="Loading sources…" />}
        {state.status === 'error' && <ErrorState message={state.message} />}

        {state.status === 'ready' && sources.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">
            No sources to show yet — they appear here once stories have been published.
          </p>
        )}

        <div className="divide-y divide-border">
          {sources.map((source) => (
            <div key={source} className="flex items-center justify-between py-3">
              <p className="font-bold">{source}</p>
              <Switch
                checked={isSourceEnabled(source)}
                onChange={() => toggleSource(source)}
                label={`Show stories from ${source}`}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
