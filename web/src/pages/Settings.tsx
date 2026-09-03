import { fetchPublishedArticles } from '../lib/api';
import { ErrorState, LoadingState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { MAX_AGE, MIN_AGE, useSettings } from '../settings/SettingsContext';

/**
 * Settings — PRD §3.6. Client-side only; §2.2 rules out user accounts.
 *
 * The source list is derived from the stories currently published, because the
 * API exposes no /api/sources endpoint yet. That means a configured-but-silent
 * source won't be listed until it has published something.
 */
export function Settings() {
  const { readingAge, setReadingAge, isSourceEnabled, toggleSource } = useSettings();
  const state = useAsync(fetchPublishedArticles, []);

  const sources =
    state.status === 'ready'
      ? [...new Set(state.data.map((article) => article.sourceName))].sort()
      : [];

  return (
    <div className="max-w-2xl">
      <h1 className="text-4xl leading-tight font-bold">Settings</h1>
      <p className="mt-3 text-lg text-ink-soft">
        These choices are saved in this browser only — there are no accounts and nothing is sent to
        us.
      </p>

      <section className="mt-8 rounded-3xl border border-paper-deep bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-bold">Default reading age</h2>
        <p className="mt-2 text-ink-soft">
          Sets the reading level shown on the home page, and the age new stories are written for.
        </p>

        <div className="mt-6 flex items-center gap-4">
          <span className="text-sm font-bold text-ink-soft">{MIN_AGE}</span>

          <input
            type="range"
            min={MIN_AGE}
            max={MAX_AGE}
            step={1}
            value={readingAge}
            onChange={(event) => setReadingAge(Number(event.target.value))}
            aria-label="Default reading age"
            aria-valuetext={`Age ${readingAge}`}
            className="h-2 grow cursor-pointer appearance-none rounded-full bg-paper-deep accent-brand"
          />

          <span className="text-sm font-bold text-ink-soft">{MAX_AGE}</span>

          <span className="min-w-20 rounded-full bg-sun-wash px-4 py-2 text-center font-bold">
            Age {readingAge}
          </span>
        </div>
      </section>

      <section className="mt-6 rounded-3xl border border-paper-deep bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-bold">News sources</h2>
        <p className="mt-2 text-ink-soft">
          Turn a source off to hide its stories from today’s news.
        </p>

        <div className="mt-5">
          {state.status === 'loading' && <LoadingState label="Loading sources…" />}
          {state.status === 'error' && <ErrorState message={state.message} />}

          {state.status === 'ready' && sources.length === 0 && (
            <p className="rounded-2xl bg-paper-deep px-4 py-6 text-center text-ink-soft">
              No sources to show yet — they appear here once stories have been published.
            </p>
          )}

          <ul className="space-y-3">
            {sources.map((source) => {
              const enabled = isSourceEnabled(source);
              return (
                <li
                  key={source}
                  className="flex items-center justify-between gap-4 rounded-2xl bg-paper-deep/60 px-5 py-4"
                >
                  <span className="font-bold">{source}</span>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`Show stories from ${source}`}
                    onClick={() => toggleSource(source)}
                    className={`relative h-8 w-14 shrink-0 rounded-full transition ${
                      enabled ? 'bg-brand' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${
                        enabled ? 'left-7' : 'left-1'
                      }`}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}
