import type { ReactNode } from 'react';
import { ExternalLink, Heart, Lightbulb, Newspaper, Sparkles } from 'lucide-react';
import { CategoryBadge, SafetyBadge } from './Badges';
import { needsFeelingNote, type KidArticle } from '../lib/types';

/**
 * The kid-facing rendering of a story — PRD §3.4.
 *
 * Purely presentational, so the public story page and the prompt sandbox render
 * from the same component. §7.3 requires sandbox output "rendered exactly like
 * the story detail page"; sharing the component is what makes that literally
 * true rather than a lookalike that can drift.
 */
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

export function StoryPreview({
  article,
  showSource = true,
  headingLevel = 'h1',
}: {
  article: KidArticle;
  showSource?: boolean;
  /** The sandbox renders inside a panel, so its story title is not the page h1. */
  headingLevel?: 'h1' | 'h2';
}) {
  const Heading = headingLevel;

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <CategoryBadge category={article.category} />
        <SafetyBadge safety={article.safety} />
        <span className="text-xs text-muted-foreground font-semibold">
          For age {article.ageTarget}+
        </span>
      </div>

      <Heading className="font-display text-4xl md:text-5xl leading-tight mb-5">
        {article.kidHeadline}
      </Heading>

      <p className="text-lg text-foreground/80 leading-relaxed mb-8">{article.summary}</p>

      {/*
        Feeling note — §3.4 and §11.1: only ever for a non-calm story. Gated on
        safety, not on the field being present, so bad data cannot show one.
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

      {showSource && (
        <div className="border-t border-border pt-6 text-sm text-muted-foreground">
          <p className="mb-1">
            Original story from{' '}
            <span className="font-semibold text-foreground">{article.sourceName}</span>
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
      )}
    </>
  );
}
