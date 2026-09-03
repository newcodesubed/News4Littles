import { Link } from 'react-router-dom';
import { CategoryBadge, SafetyBadge } from './Badges';
import type { KidArticle } from '../lib/types';

/** Story card — PRD §3.3. */
export function StoryCard({ article }: { article: KidArticle }) {
  return (
    <article className="flex h-full flex-col rounded-3xl border border-paper-deep bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex flex-wrap items-center gap-2">
        <CategoryBadge category={article.category} />
        <SafetyBadge safety={article.safety} />
      </div>

      <h3 className="mt-4 text-xl leading-snug font-bold">
        <Link to={`/story/${article.id}`} className="hover:text-brand-deep">
          {article.kidHeadline}
        </Link>
      </h3>

      <p className="mt-2 grow text-ink-soft">{article.summary}</p>

      <p className="mt-4 text-sm font-semibold text-ink-soft">
        {article.readingMinutes} min read · Age {article.ageTarget}+
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-paper-deep pt-4 text-sm">
        <span className="text-ink-soft">{article.sourceName}</span>
        <a
          href={article.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="font-semibold text-brand-deep hover:underline"
        >
          Original (for grown-ups) ↗
        </a>
      </div>
    </article>
  );
}
