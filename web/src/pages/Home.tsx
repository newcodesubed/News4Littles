import { Link } from 'react-router-dom';
import { HeroArt } from '../components/HeroArt';
import { StoryCard } from '../components/StoryCard';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { fetchPublishedArticles } from '../lib/api';
import { todayLine } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useSettings } from '../settings/SettingsContext';

/** Home — PRD §3.2. */
export function Home() {
  const { readingAge, isSourceEnabled, disabledSources } = useSettings();
  const state = useAsync(fetchPublishedArticles, []);

  // The reading-age slider drives the badge only; it does not filter the feed
  // (§11.1 — it sets the default age target for new simplifications).
  // Source toggles (§3.6) do filter what the reader sees.
  const articles = state.status === 'ready' ? state.data.filter((a) => isSourceEnabled(a.sourceName)) : [];
  const hiddenBySettings = state.status === 'ready' ? state.data.length - articles.length : 0;

  return (
    <>
      <section className="grid items-center gap-8 rounded-4xl bg-paper-deep/70 px-6 py-10 sm:px-10 md:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="font-semibold text-ink-soft">{todayLine()}</p>

          <h1 className="mt-3 text-4xl leading-tight font-bold sm:text-5xl">
            The world, explained kindly for curious kids
          </h1>

          <p className="mt-4 max-w-xl text-lg text-ink-soft">
            Calm, true stories from trusted news sources — rewritten for young readers, with words
            to know and gentle feeling notes.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="#today"
              className="rounded-full bg-brand px-6 py-3 font-bold text-white shadow-sm transition hover:bg-brand-deep"
            >
              Read today’s news
            </a>
            <Link
              to="/podcast"
              className="rounded-full border-2 border-brand bg-white px-6 py-3 font-bold text-brand-deep transition hover:bg-brand-wash"
            >
              Listen to today’s podcast
            </Link>
          </div>

          <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-sun-wash px-4 py-2 text-sm font-bold">
            <span aria-hidden="true">🎈</span>
            Default reading level: age {readingAge}
            <Link to="/settings" className="font-bold text-brand-deep underline">
              change
            </Link>
          </p>
        </div>

        <div className="flex justify-center md:justify-end">
          <HeroArt />
        </div>
      </section>

      <section id="today" className="scroll-mt-24 pt-14">
        <h2 className="text-3xl font-bold">Today’s news for curious kids.</h2>
        <p className="mt-2 text-lg text-ink-soft">A short, kind round-up of real stories.</p>

        <div className="mt-8">
          {state.status === 'loading' && <LoadingState />}
          {state.status === 'error' && <ErrorState message={state.message} />}

          {state.status === 'ready' && articles.length === 0 && (
            <EmptyState title="No stories today — yet">
              {state.data.length > 0
                ? 'Every story is hidden by your news source settings. Turn a source back on to see them.'
                : 'Our editors are still reading. Check back a little later for today’s round-up.'}
            </EmptyState>
          )}

          {articles.length > 0 && (
            <>
              <ul className="grid gap-6 sm:grid-cols-2">
                {articles.map((article) => (
                  <li key={article.id}>
                    <StoryCard article={article} />
                  </li>
                ))}
              </ul>

              {hiddenBySettings > 0 && (
                <p className="mt-6 text-center text-sm text-ink-soft">
                  {hiddenBySettings} {hiddenBySettings === 1 ? 'story is' : 'stories are'} hidden
                  because you turned off {disabledSources.join(', ')}.{' '}
                  <Link to="/settings" className="font-semibold text-brand-deep underline">
                    Change sources
                  </Link>
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
