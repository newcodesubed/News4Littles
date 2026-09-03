import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Heart, Lightbulb, Newspaper, Sparkles } from 'lucide-react';
import { CategoryBadge, SafetyBadge } from '../components/Badges';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { fetchArticle } from '../lib/api';
import { needsFeelingNote } from '../lib/types';
import { useAsync } from '../lib/useAsync';

function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground mb-6"
    >
      <ArrowLeft className="w-4 h-4" /> Back to today
    </Link>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="font-display text-2xl mb-2 inline-flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        {title}
      </h2>
      <div className="text-foreground/80 leading-relaxed">{children}</div>
    </div>
  );
}

/** Story detail — PRD §3.4, layout matching the prototype. */
export function StoryDetail() {
  const { id = '' } = useParams();
  const state = useAsync(() => fetchArticle(id), [id]);

  if (state.status === 'loading') {
    return (
      <div className="container max-w-3xl py-10">
        <LoadingState label="Opening the story…" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="container max-w-3xl py-10">
        <BackLink />
        {state.message.startsWith('No article') ? (
          <EmptyState title="We couldn’t find that story">
            It may have been taken down. Head back to today’s news to see what’s there.
          </EmptyState>
        ) : (
          <ErrorState message={state.message} />
        )}
      </div>
    );
  }

  const article = state.data;

  // The public site shows published stories only (§11.1). A direct link to a
  // story still in review must not expose unreviewed content to a child.
  if (article.status !== 'published') {
    return (
      <div className="container max-w-3xl py-10">
        <BackLink />
        <EmptyState title="This story isn’t ready yet">
          A grown-up editor is still reading it. It will appear on the home page once it has been
          checked.
        </EmptyState>
      </div>
    );
  }

  return (
    <article className="container max-w-3xl py-10">
      <BackLink />

      <div className="flex items-center gap-2 flex-wrap mb-4">
        <CategoryBadge category={article.category} />
        <SafetyBadge safety={article.safety} />
        <span className="text-xs text-muted-foreground font-semibold">
          For age {article.ageTarget}+
        </span>
      </div>

      <h1 className="font-display text-4xl md:text-5xl leading-tight mb-5">{article.kidHeadline}</h1>

      <p className="text-lg text-foreground/80 leading-relaxed mb-8">{article.summary}</p>

      {/*
        Feeling note — PRD §3.4 and §11.1: rendered ONLY for non-calm stories.
        This is a safety behaviour, not decoration: a reassurance note on a calm
        story teaches children that ordinary news is frightening.
      */}
      {needsFeelingNote(article) && article.feelingNote && (
        <div className="bg-surface-sky rounded-3xl p-5 mb-8 flex gap-3">
          <Heart className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div>
            <p className="font-bold mb-1">A little feeling note</p>
            <p className="text-foreground/80 text-sm leading-relaxed">{article.feelingNote}</p>
          </div>
        </div>
      )}

      <Section icon={<Newspaper className="w-5 h-5" />} title="What happened?">
        <p>{article.whatHappened}</p>
      </Section>

      <Section icon={<Sparkles className="w-5 h-5" />} title="Why it matters">
        <p>{article.whyItMatters}</p>
      </Section>

      {article.vocab.length > 0 && (
        <div className="bg-surface-mint rounded-3xl p-6 my-8">
          <h2 className="font-display text-2xl mb-4">Words to know</h2>
          <ul className="space-y-3">
            {article.vocab.map((entry) => (
              <li key={entry.word}>
                <span className="font-bold text-accent-foreground">{entry.word}</span>
                <span className="text-foreground/80"> — {entry.definition}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-surface-sun rounded-3xl p-6 my-8 flex gap-3">
        <Lightbulb className="w-6 h-6 text-amber-700 shrink-0 mt-0.5" />
        <div>
          <p className="font-display text-xl mb-1">Something to think about</p>
          <p className="text-foreground/80">{article.thinkAbout}</p>
        </div>
      </div>

      <div className="border-t border-border pt-6 text-sm text-muted-foreground">
        <p className="mb-1">
          Original story from <span className="font-semibold text-foreground">{article.sourceName}</span>
        </p>
        <a
          href={article.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
        >
          Read the original (for grown-ups) <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
    </article>
  );
}
