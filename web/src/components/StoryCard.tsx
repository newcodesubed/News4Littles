import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { CategoryBadge, SafetyBadge } from './Badges';
import type { KidArticle } from '../lib/types';

/** Story card — PRD §3.3, markup matching the prototype. */
export function StoryCard({ article }: { article: KidArticle }) {
  return (
    <Link
      to={`/story/${article.id}`}
      className="group block bg-card rounded-3xl p-6 shadow-soft hover:shadow-card transition-all hover:-translate-y-1 border border-border/60"
    >
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <CategoryBadge category={article.category} />
        <SafetyBadge safety={article.safety} />
      </div>

      <h3 className="font-display text-2xl leading-tight mb-3 group-hover:text-primary transition-colors">
        {article.kidHeadline}
      </h3>

      <p className="text-foreground/70 text-base leading-relaxed line-clamp-3 mb-4">
        {article.summary}
      </p>

      <div className="flex items-center justify-between text-xs text-muted-foreground font-semibold">
        <span className="inline-flex items-center gap-1">
          <Clock className="w-3.5 h-3.5" /> {article.readingMinutes} min read
        </span>
        <span>From {article.sourceName}</span>
      </div>
    </Link>
  );
}
