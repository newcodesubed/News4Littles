import { useState } from 'react';
import { Headphones, MessageCircle, Pause, Play } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/States';
import { fetchPublishedArticles } from '../lib/api';
import { useSettings } from '../settings/SettingsContext';
import { useAsync } from '../lib/useAsync';
import type { KidArticle } from '../lib/types';

/**
 * Podcast — PRD §3.5, layout matching the prototype.
 *
 * The player is a placeholder: real text-to-speech is out of scope (§2.2, §14)
 * and needs a key only the product owner can supply (§13.2).
 *
 * The prototype reads a pre-written episode object; here the intro and segment
 * scripts are derived from today's published stories, using the prototype's
 * phrasing.
 */
function segmentScript(article: KidArticle): string {
  const word = article.vocab[0];
  return [
    `Our next story is from ${article.sourceName}. ${article.summary}`,
    word ? `Here's a fun word: "${word.word}" — ${word.definition}` : '',
    `Something to wonder about: ${article.thinkAbout}`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function Podcast() {
  const [playing, setPlaying] = useState(false);
  const { readingAge } = useSettings();
  const state = useAsync(() => fetchPublishedArticles(readingAge), [readingAge]);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const articles = state.status === 'ready' ? state.data : [];
  const minutes = articles.reduce((total, a) => total + a.readingMinutes, 0);

  return (
    <div>
      <section className="bg-gradient-sky">
        <div className="container py-12 md:py-16">
          <div className="bg-card rounded-3xl shadow-card border border-border p-6 md:p-10 max-w-3xl mx-auto">
            <div className="flex items-center gap-2 text-xs font-bold text-primary uppercase tracking-wider mb-3">
              <Headphones className="w-4 h-4" /> Daily Episode · {today}
            </div>

            <h1 className="font-display text-3xl md:text-4xl leading-tight mb-3">
              Today's Curious Kids News — Bright news from around the world
            </h1>

            <p className="text-muted-foreground mb-6">
              ~{minutes} minutes · {articles.length} short{' '}
              {articles.length === 1 ? 'story' : 'stories'}
            </p>

            <div className="bg-gradient-sun rounded-2xl p-5 flex items-center gap-4">
              <button
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? 'Pause' : 'Play'}
                className="w-14 h-14 rounded-full shadow-pop bg-primary text-primary-foreground grid place-items-center shrink-0"
              >
                {playing ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
              </button>

              <div className="flex-1">
                <div className="h-2 bg-background/50 rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-primary rounded-full transition-all ${
                      playing ? 'w-1/3 animate-pulse' : 'w-0'
                    }`}
                  />
                </div>
                <p className="text-xs text-foreground/70 mt-2 font-semibold">
                  Demo player — connect text-to-speech (Lovable AI / ElevenLabs) to generate real
                  audio.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="container max-w-3xl py-10 space-y-8">
        {state.status === 'loading' && <LoadingState label="Building today’s episode…" />}
        {state.status === 'error' && <ErrorState message={state.message} />}

        {state.status === 'ready' && (
          <>
            <div className="bg-card rounded-3xl border border-border p-6 shadow-soft">
              <h2 className="font-display text-2xl mb-2 inline-flex items-center gap-2">
                <MessageCircle className="w-5 h-5 text-primary" /> Friendly intro
              </h2>
              <p className="text-foreground/80 leading-relaxed">
                Hi friends! Welcome back to News for Curious Kids. I'm so glad you're here. Today we
                have {articles.length} short {articles.length === 1 ? 'story' : 'stories'}. Ready?
                Let's go!
              </p>
            </div>

            <div>
              <h2 className="font-display text-2xl mb-4">Today's stories</h2>

              {articles.length === 0 ? (
                <p className="text-center text-muted-foreground py-12">
                  No episode today yet. Once today's stories are published, they'll appear here as
                  segments.
                </p>
              ) : (
                <ol className="space-y-4">
                  {articles.map((article, index) => (
                    <li
                      key={article.id}
                      className="bg-card rounded-2xl p-5 border border-border shadow-soft"
                    >
                      <div className="text-xs font-bold text-primary mb-1">Story {index + 1}</div>
                      <h3 className="font-display text-lg mb-2">{article.kidHeadline}</h3>
                      <p className="text-sm text-foreground/70 leading-relaxed">
                        {segmentScript(article)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="bg-card rounded-3xl border border-border p-6 shadow-soft">
              <h2 className="font-display text-2xl mb-2">Closing</h2>
              <p className="text-foreground/80 leading-relaxed">
                That's all for today, friends. Remember: it's okay to feel curious, it's okay to ask
                questions, and it's wonderful to learn something new. Talk to a grown-up about your
                favorite story today. See you tomorrow!
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
