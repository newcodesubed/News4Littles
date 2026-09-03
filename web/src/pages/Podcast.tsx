import { Link } from 'react-router-dom';
import { CategoryBadge, SafetyBadge } from '../components/Badges';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { fetchPublishedArticles } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * Podcast — PRD §3.5. One segment per published story.
 *
 * The player is a placeholder: real text-to-speech is explicitly out of scope
 * (§2.2, §14) and needs a key only the product owner can supply (§13.2).
 */
export function Podcast() {
  const state = useAsync(fetchPublishedArticles, []);

  return (
    <>
      <header>
        <h1 className="text-4xl leading-tight font-bold">
          Today’s Curious Kids News — Bright news from around the world
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-soft">
          Pop your headphones on. We’ve gathered today’s stories into one short, friendly listen —
          the same calm round-up you’ll find on the home page, read out loud.
        </p>
      </header>

      <section className="mt-8 rounded-3xl border border-paper-deep bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-4">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-wash text-2xl text-brand-deep"
          >
            ▶
          </span>
          <div className="grow">
            <div className="h-2 w-full rounded-full bg-paper-deep">
              <div className="h-2 w-0 rounded-full bg-brand" />
            </div>
            <p className="mt-2 text-sm font-semibold text-ink-soft">0:00 / --:--</p>
          </div>
        </div>

        <p className="mt-5 rounded-2xl bg-sun-wash px-4 py-3 text-sm font-semibold">
          Demo player — connect text-to-speech (Lovable AI / ElevenLabs) to generate real audio.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold">Today’s segments</h2>

        <div className="mt-4">
          {state.status === 'loading' && <LoadingState label="Building today’s episode…" />}
          {state.status === 'error' && <ErrorState message={state.message} />}

          {state.status === 'ready' && state.data.length === 0 && (
            <EmptyState title="No episode today — yet">
              Once today’s stories are published, they’ll appear here as segments.
            </EmptyState>
          )}

          {state.status === 'ready' && state.data.length > 0 && (
            <ol className="mt-2 space-y-3">
              {state.data.map((article, index) => (
                <li
                  key={article.id}
                  className="flex flex-wrap items-center gap-4 rounded-2xl border border-paper-deep bg-white p-5 shadow-sm"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-wash font-bold text-brand-deep">
                    {index + 1}
                  </span>

                  <div className="grow">
                    <div className="flex flex-wrap items-center gap-2">
                      <CategoryBadge category={article.category} />
                      <SafetyBadge safety={article.safety} />
                    </div>
                    <h3 className="mt-2 text-lg font-bold">
                      <Link to={`/story/${article.id}`} className="hover:text-brand-deep">
                        {article.kidHeadline}
                      </Link>
                    </h3>
                  </div>

                  <span className="text-sm font-semibold text-ink-soft">
                    ~{article.readingMinutes} min
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </>
  );
}
