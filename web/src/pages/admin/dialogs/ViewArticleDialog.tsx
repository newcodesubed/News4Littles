import { ExternalLink } from 'lucide-react';
import { StoryPreview } from '../../../components/StoryPreview';
import { Button } from '../../../ui/Button';
import { Notice } from '../../../ui/Surface';
import type { AdminArticle } from '../../../admin/types';
import { Modal } from './Modal';

const STATUS_LABEL: Record<string, string> = {
  pending_review: 'Waiting for review',
  published: 'Live on the site',
  rejected: 'Rejected',
};

/**
 * Read a story the way a child would, before deciding on it.
 *
 * Uses the same StoryPreview as the public story page, so what an editor
 * approves is exactly what a reader gets — a summary line in a queue row is not
 * enough to judge safety or tone.
 */
export function ViewArticleDialog({
  article,
  onClose,
  onEdit,
  onPublish,
  onReject,
}: {
  article: AdminArticle;
  onClose: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onReject: () => void;
}) {
  return (
    <Modal title="Read before deciding" onClose={onClose} wide>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted-foreground">
        <span className="rounded-full bg-muted px-2.5 py-1">{STATUS_LABEL[article.status] ?? article.status}</span>
        <span>{article.sourceName}</span>
        <span>·</span>
        <span>{article.readingMinutes} min read</span>
        {article.editedByHuman && <span className="rounded-full bg-muted px-2.5 py-1">edited by a person</span>}
      </div>

      {article.rejectReason && (
        <div className="mb-5">
          <Notice tone="warn">Rejected earlier: {article.rejectReason}</Notice>
        </div>
      )}

      {/* Exactly what a reader sees. */}
      <div className="rounded-3xl border border-border bg-background p-6">
        <StoryPreview article={article} showSource={false} headingLevel="h2" />
      </div>

      <div className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
        <p>Original headline: {article.originalHeadline}</p>
        <a
          href={article.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 font-semibold text-primary hover:underline"
        >
          Read the original <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-border pt-5">
        <Button variant="ghost" size="lg" onClick={onClose}>Close</Button>
        <Button variant="outline" size="lg" onClick={onEdit}>Edit</Button>
        {article.status !== 'rejected' && (
          <Button variant="outline" size="lg" onClick={onReject}>Reject</Button>
        )}
        {article.status !== 'published' && (
          <Button size="lg" onClick={onPublish}>Publish</Button>
        )}
      </div>
    </Modal>
  );
}
