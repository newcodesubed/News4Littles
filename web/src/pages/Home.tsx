import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Headphones, Heart } from 'lucide-react';
import { CATEGORIES, CategoryBadge } from '../components/Badges';
import { StoryCard } from '../components/StoryCard';
import { ErrorState, LoadingState } from '../components/States';
import heroImage from '../assets/hero-kids-news.jpg';
import { fetchPublishedArticles } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useSettings } from '../settings/SettingsContext';

/** Home — PRD §3.2, layout matching the prototype. */
export function Home() {
  const { readingAge, isSourceEnabled } = useSettings();
  const [category, setCategory] = useState<string | null>(null);
  const state = useAsync(() => fetchPublishedArticles(readingAge), [readingAge]);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  // Source toggles (§3.6) filter the feed. The reading-age slider changes the
  // TEXT: a story exists in one version per age, and the API serves the version
  // for this reader (§6), so moving the slider refetches rather than relabels.
  const published = state.status === 'ready' ? state.data.filter((a) => isSourceEnabled(a.sourceName)) : [];
  const visible = category ? published.filter((a) => a.category === category) : published;

  return (
    <div>
      <section className="bg-gradient-hero">
        <div className="container grid md:grid-cols-2 gap-10 py-12 md:py-20 items-center">
          <div className="animate-fade-up">
            <p className="text-sm font-bold text-primary uppercase tracking-wider mb-3">
              Today · {today}
            </p>

            <h1 className="font-display text-5xl md:text-6xl leading-[1.05] mb-5">
              The world, <span className="text-primary">explained kindly</span> for curious kids.
            </h1>

            <p className="text-lg text-foreground/75 mb-7 max-w-lg">
              Calm, true stories from trusted news sources — rewritten for young readers, with words
              to know and gentle feeling notes.
            </p>

            <div className="flex flex-wrap gap-3">
              <a
                href="#today"
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-3 rounded-full font-bold shadow-pop hover:scale-105 transition-transform"
              >
                Read today's news
              </a>
              <Link
                to="/podcast"
                className="inline-flex items-center gap-2 bg-card text-foreground px-5 py-3 rounded-full font-bold shadow-soft hover:shadow-card transition-shadow border border-border"
              >
                <Headphones className="w-4 h-4" /> Listen to today's podcast
              </Link>
            </div>

            <p className="text-xs text-muted-foreground mt-5 inline-flex items-center gap-1.5">
              <Heart className="w-3.5 h-3.5 text-primary" /> Default reading level: age {readingAge}
            </p>
          </div>

          <div className="animate-float">
            <img
              src={heroImage}
              alt="A friendly newspaper under a sunny sky with floating world icons"
              width={1536}
              height={1024}
              className="rounded-3xl shadow-card w-full h-auto"
            />
          </div>
        </div>
      </section>

      <section id="today" className="container py-14">
        <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
          <div>
            <h2 className="font-display text-3xl md:text-4xl mb-1">Today's stories</h2>
            <p className="text-muted-foreground">
              A short, kind round-up of real stories from around the world.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setCategory(null)}
              className={`text-xs font-bold px-3 py-1.5 rounded-full ${
                category ? 'bg-muted text-foreground/70' : 'bg-foreground text-background'
              }`}
            >
              All
            </button>
            {CATEGORIES.map((name) => {
              const active = category === name;
              return (
                <button
                  key={name}
                  onClick={() => setCategory(active ? null : name)}
                  className={active ? 'ring-2 ring-foreground rounded-full' : ''}
                >
                  <CategoryBadge category={name} />
                </button>
              );
            })}
          </div>
        </div>

        {state.status === 'loading' && <LoadingState />}
        {state.status === 'error' && <ErrorState message={state.message} />}

        {state.status === 'ready' && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {visible.map((article) => (
                <StoryCard key={article.id} article={article} />
              ))}
            </div>

            {visible.length === 0 && (
              <p className="text-center text-muted-foreground py-12">
                {published.length === 0
                  ? 'No stories today yet. Our editors are still reading — check back a little later!'
                  : 'No stories in that category today. Try another!'}
              </p>
            )}
          </>
        )}
      </section>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        Made with care ·{' '}
        <Link to="/about" className="underline hover:text-foreground">
          About this project
        </Link>
      </footer>
    </div>
  );
}
