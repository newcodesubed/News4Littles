import { Link, useParams } from 'react-router-dom';
import { CategoryBadge, SafetyBadge } from '../components/Badges';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { fetchArticle } from '../lib/api';
import { needsFeelingNote } from '../lib/types';
import { useAsync } from '../lib/useAsync';

function BackLink() {
  return (
    <Link to="/" className="font-semibold text-brand-deep hover:underline">
      ← Back to today
    </Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-2xl font-bold">{title}</h2>
      <div className="mt-3 text-lg leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

/** Story detail — PRD §3.4. */
export function StoryDetail() {
  const { id = '' } = useParams();
  const state = useAsync(() => fetchArticle(id), [id]);

  if (state.status === 'loading') return <LoadingState label="Opening the story…" />;

  if (state.status === 'error') {
    return (
      <>
        <BackLink />
        <div className="mt-6">
          {state.status === 'error' && state.message.startsWith('No article') ? (
            <EmptyState title="We couldn’t find that story">
              It may have been taken down. Head back to today’s news to see what’s there.
            </EmptyState>
          ) : (
            <ErrorState message={state.message} />
          )}
        </div>
      </>
    );
  }

  const article = state.data;

  // The public site shows published stories only (§11.1). A direct link to a
  // story still in review must not expose unreviewed content to a child.
  if (article.status !== 'published') {
    return (
      <>
        <BackLink />
        <div className="mt-6">
          <EmptyState title="This story isn’t ready yet">
            A grown-up editor is still reading it. It will appear on the home page once it has been
            checked.
          </EmptyState>
        </div>
      </>
    );
  }

  return (
    <article>
      <BackLink />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <CategoryBadge category={article.category} />
        <SafetyBadge safety={article.safety} />
      </div>

      <h1 className="mt-4 text-4xl leading-tight font-bold">{article.kidHeadline}</h1>

      <p className="mt-3 text-sm font-semibold text-ink-soft">
        {article.readingMinutes} min read · Age {article.ageTarget}+ · {article.sourceName}
      </p>

      <p className="mt-5 text-xl leading-relaxed">{article.summary}</p>

      <Section title="What happened?">{article.whatHappened}</Section>
      <Section title="Why it matters">{article.whyItMatters}</Section>

      {article.vocab.length > 0 && (
        <section className="mt-8">
          <h2 className="text-2xl font-bold">Words to know</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {article.vocab.map((entry) => (
              <li
                key={entry.word}
                className="rounded-2xl border border-paper-deep bg-white p-4 shadow-sm"
              >
                <p className="font-display text-lg font-bold text-brand-deep">{entry.word}</p>
                <p className="mt-1 text-ink-soft">{entry.definition}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8 rounded-3xl bg-brand-wash p-6">
        <h2 className="text-2xl font-bold">Think about</h2>
        <p className="mt-2 text-lg text-ink">{article.thinkAbout}</p>
      </section>

      {/*
        Feeling note — PRD §3.4 and §11.1: rendered ONLY for non-calm stories.
        This is a safety behaviour, not decoration: showing a reassurance note on
        a calm story teaches children that ordinary news is frightening.
      */}
      {needsFeelingNote(article) && article.feelingNote && (
        <section className="mt-6 rounded-3xl border-2 border-sun bg-sun-wash p-6">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <span aria-hidden="true">💛</span>
            Feeling note
          </h2>
          <p className="mt-2 text-lg text-ink">{article.feelingNote}</p>
        </section>
      )}

      <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-paper-deep pt-6">
        <BackLink />
        <a
          href={article.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="font-semibold text-brand-deep hover:underline"
        >
          Read the original (for grown-ups) ↗
        </a>
      </div>
    </article>
  );
}
