import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { StoryPreview } from '../components/StoryPreview';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { fetchArticle } from '../lib/api';
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

/** Story detail — PRD §3.4. The rendering itself lives in StoryPreview. */
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
      {/* One back link, at the top, matching the reference prototype. */}
      <StoryPreview article={article} />
    </article>
  );
}
