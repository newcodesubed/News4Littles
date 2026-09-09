import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { StoryPreview } from '../../../components/StoryPreview';
import { Button } from '../../../ui/Button';
import { Notice } from '../../../ui/Surface';
import type { AdminStory } from '../../../admin/types';
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
  story,
  onClose,
  onEdit,
  onPublish,
  onReject,
}: {
  story: AdminStory;
  onClose: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onReject: () => void;
}) {
  // Opens on the youngest version: it is the strictest reading level and the
  // one most likely to need a second look.
  const [ageTarget, setAgeTarget] = useState(story.versions[0].ageTarget);
  const version =
    story.versions.find((candidate) => candidate.ageTarget === ageTarget) ?? story.versions[0];

  return (
    <Modal title="Read before deciding" onClose={onClose} wide>
      {/* §2.2 promises a human read every word a child sees. One Publish
          button covers every age, so every age has to be readable here. */}
      {story.versions.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold text-muted-foreground">Reading age</span>
          {story.versions.map((candidate) => (
            <button
              key={candidate.id}
              onClick={() => setAgeTarget(candidate.ageTarget)}
              aria-current={candidate.ageTarget === ageTarget ? 'true' : undefined}
              className={`rounded-full px-3 py-1 text-xs font-bold transition ${
                candidate.ageTarget === ageTarget
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground/70 hover:bg-muted/70'
              }`}
            >
              Age {candidate.ageTarget}
            </button>
          ))}
        </div>
      )}
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted-foreground">
        <span className="rounded-full bg-muted px-2.5 py-1">{STATUS_LABEL[version.status] ?? version.status}</span>
        <span>{version.sourceName}</span>
        <span>·</span>
        <span>{version.readingMinutes} min read</span>
        {version.editedByHuman && <span className="rounded-full bg-muted px-2.5 py-1">edited by a person</span>}
      </div>

      {version.rejectReason && (
        <div className="mb-5">
          <Notice tone="warn">Rejected earlier: {version.rejectReason}</Notice>
        </div>
      )}

      {/* Exactly what a reader sees. */}
      <div className="rounded-3xl border border-border bg-background p-6">
        <StoryPreview article={version} showSource={false} headingLevel="h2" />
      </div>

      <div className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
        <p>Original headline: {version.originalHeadline}</p>
        <a
          href={version.sourceUrl}
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
        {version.status !== 'rejected' && (
          <Button variant="outline" size="lg" onClick={onReject}>Reject</Button>
        )}
        {version.status !== 'published' && (
          <Button size="lg" onClick={onPublish}>
            {story.versions.length > 1 ? `Publish all ${story.versions.length}` : 'Publish'}
          </Button>
        )}
      </div>
    </Modal>
  );
}
