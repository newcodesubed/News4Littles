import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Headphones } from 'lucide-react';
import { StoryPreview } from '../../../components/StoryPreview';
import { Button } from '../../../ui/Button';
import { Notice } from '../../../ui/Surface';
import type { AdminArticle, AdminStory } from '../../../admin/types';
import { Modal } from './Modal';
import { ageBandLabel } from '../../../lib/ageBands';

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
  position,
  busy = false,
  error = null,
  onClose,
  onEdit,
  onPublish,
  onReject,
  onPrevious,
  onNext,
}: {
  story: AdminStory;
  /** Where the story sits in the queue on screen, zero-based. */
  position?: { index: number; total: number };
  /** An action on this story is in flight. */
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  /** Given the version on screen: edits are per version, unlike publish. */
  onEdit: (version: AdminArticle) => void;
  /** `andNext` asks to show the next story afterwards instead of closing. */
  onPublish: (andNext: boolean) => void;
  onReject: (andNext: boolean) => void;
  /** Absent at either end of the list. */
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  // Opens on the youngest version: it is the strictest reading level and the
  // one most likely to need a second look.
  const [ageTarget, setAgeTarget] = useState(story.versions[0].ageTarget);
  const version =
    story.versions.find((candidate) => candidate.ageTarget === ageTarget) ?? story.versions[0];

  // ← and → move through the list without acting on anything. Publish and
  // Reject stay click-only: a stray key must never put a story live.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'ArrowRight') onNext?.();
      if (event.key === 'ArrowLeft') onPrevious?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onNext, onPrevious]);

  const publishLabel = story.versions.length > 1 ? `Publish all ${story.versions.length}` : 'Publish';

  return (
    <Modal title="Read before deciding" onClose={onClose} wide>
      {position && position.total > 1 && (
        <div className="mb-4 flex items-center justify-between gap-2 text-sm">
          <Button variant="ghost" size="sm" onClick={onPrevious} disabled={!onPrevious}
            aria-label="Previous story">
            <ChevronLeft className="w-4 h-4" /> Previous
          </Button>
          <span className="font-bold text-muted-foreground">
            Story {position.index + 1} of {position.total}
          </span>
          <Button variant="ghost" size="sm" onClick={onNext} disabled={!onNext} aria-label="Next story">
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* §2.2 promises a human read every word a child sees. One Publish
          button covers every reading group, so every group has to be readable
          here. */}
      {story.versions.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold text-muted-foreground">Reading group</span>
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
              {ageBandLabel(candidate.ageTarget)}
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

      {/* §2.2's promise is about every word a child GETS, and the script is
          words they hear. The model writes it from the article rather than from
          the story above, so approving the story is not approving this — it has
          to be read here or it reaches a child unread. StoryPreview is shared
          with the public site, which never shows the script, so it lives here. */}
      <div className="mt-5 rounded-3xl border border-border bg-background p-6">
        <h3 className="font-display text-xl mb-2 inline-flex items-center gap-2">
          <Headphones className="w-5 h-5 text-primary" />
          Read aloud on the podcast page
        </h3>
        {version.audioScript ? (
          <p className="text-foreground/80 leading-relaxed whitespace-pre-line">{version.audioScript}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No script for this version. The podcast page reads its summary, word and question
            instead.
          </p>
        )}
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

      {error && <p role="alert" className="mt-5 text-sm font-bold text-destructive">{error}</p>}

      {/* "& next" only when there is a next story; on the last one the plain
          buttons already close the dialog. */}
      <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-border pt-5">
        <Button variant="ghost" size="lg" onClick={onClose}>Close</Button>
        <Button variant="outline" size="lg" onClick={() => onEdit(version)} disabled={busy}>Edit</Button>
        {version.status !== 'rejected' && (
          <>
            <Button variant="outline" size="lg" onClick={() => onReject(false)} disabled={busy}>Reject</Button>
            {onNext && (
              <Button variant="outline" size="lg" onClick={() => onReject(true)} disabled={busy}>
                Reject &amp; next
              </Button>
            )}
          </>
        )}
        {version.status !== 'published' && (
          <>
            <Button variant={onNext ? 'outline' : 'primary'} size="lg" onClick={() => onPublish(false)} disabled={busy}>
              {publishLabel}
            </Button>
            {onNext && (
              <Button size="lg" onClick={() => onPublish(true)} disabled={busy}>
                {publishLabel} &amp; next
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
