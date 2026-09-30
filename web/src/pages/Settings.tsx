import { BookOpen, Rss } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/States';
import { fetchPublishedArticles } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { MAX_AGE, MIN_AGE, useSettings } from '../settings/SettingsContext';
import { AGE_BANDS, bandForAge, formatAgeBand } from '../lib/ageBands';

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

/** Where an age sits along the slider, as a percentage of the distance between the end stops. */
const along = (age: number) => ((age - MIN_AGE) / (MAX_AGE - MIN_AGE)) * 100;

const AGES = Array.from({ length: MAX_AGE - MIN_AGE + 1 }, (_, i) => MIN_AGE + i);

/**
 * The reading-age slider, with every age marked under its stop and the three
 * reading groups under those, so the choice reads off the control itself.
 *
 * The marks sit in a row inset by half a thumb (mx-3 = the age-slider's
 * --thumb / 2), which is exactly the span the thumb's centre travels.
 */
function ReadingAge({ age, onChange }: { age: number; onChange: (age: number) => void }) {
  const band = bandForAge(age);

  return (
    <div className="bg-card rounded-3xl border border-border p-6 shadow-soft mb-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="font-display text-xl mb-1 inline-flex items-center gap-2">
            <BookOpen className="w-5 h-5" /> Reading age
          </h2>
          <p className="text-sm text-muted-foreground">
            Younger readers get shorter sentences and simpler words.
          </p>
        </div>
        <span className="font-display text-3xl text-primary shrink-0">Age {age}</span>
      </div>

      <input
        type="range"
        min={MIN_AGE}
        max={MAX_AGE}
        step={1}
        value={age}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Reading age"
        aria-valuetext={`Age ${age}, reading group ${formatAgeBand(band)}`}
        className="age-slider"
        style={{ '--fill': along(age) / 100 } as React.CSSProperties}
      />

      <div aria-hidden className="relative mx-3 mt-3 h-6">
        {AGES.map((mark) => (
          <span
            key={mark}
            className={`absolute top-0 -translate-x-1/2 text-sm tabular-nums transition-colors ${
              mark === age ? 'font-bold text-primary' : 'text-muted-foreground'
            }`}
            style={{ left: `${along(mark)}%` }}
          >
            {mark}
          </span>
        ))}
      </div>

      <div aria-hidden className="relative mx-3 mt-2 h-8">
        {AGE_BANDS.map((group) => {
          // A group ends halfway to the next age; the end groups reach the track's ends, past the inset.
          const first = group.minAge === MIN_AGE;
          const last = group.maxAge === MAX_AGE;
          const start = first ? 0 : along(group.minAge - 0.5);
          const end = last ? 100 : along(group.maxAge + 0.5);
          const current = group === band;
          return (
            <span
              key={group.minAge}
              className={`absolute inset-y-0 ${first ? 'pr-0.5' : last ? 'pl-0.5' : 'px-0.5'}`}
              style={{
                left: first ? '-0.75rem' : `${start}%`,
                width: `calc(${end - start}% + ${(first ? 0.75 : 0) + (last ? 0.75 : 0)}rem)`,
              }}
            >
              <span
                className={`flex h-full items-center justify-center rounded-full text-xs font-bold transition-colors ${
                  current ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}
              >
                Ages {formatAgeBand(group)}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function Settings() {
  const { readingAge, setReadingAge, isSourceEnabled, toggleSource } = useSettings();
  const state = useAsync(() => fetchPublishedArticles(readingAge), [readingAge]);

  const sources =
    state.status === 'ready'
      ? [...new Set(state.data.map((article) => article.sourceName))].sort()
      : [];

  return (
    <div className="container max-w-3xl py-10">
      <h1 className="font-display text-4xl mb-2">Settings</h1>
      <p className="text-muted-foreground mb-8">
        Saved in this browser only — no account, and nothing is sent to us.
      </p>

      <ReadingAge age={readingAge} onChange={setReadingAge} />

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
