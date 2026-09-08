import { Play } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Notice } from '../../../ui/Surface';
import type { ScrapeRun, ScrapeStatus } from './types';

/** A one-line summary of what a run did (§4.4 "last-run results"). */
export function LastRunSummary({ run }: { run: ScrapeRun | undefined }) {
  if (!run) return <span className="text-muted-foreground">never run</span>;

  const when = new Date(run.finishedAt).toLocaleString();

  if (!run.ok) {
    return (
      <span className="text-destructive">
        failed {when} — {run.error}
      </span>
    );
  }

  return (
    <span>
      {when} · <strong>{run.inserted}</strong> new
      {run.skippedNotNew > 0 && `, ${run.skippedNotNew} already seen`}
      {run.skippedAlreadyStored > 0 && `, ${run.skippedAlreadyStored} duplicate`}
      {run.skippedUnusable > 0 && `, ${run.skippedUnusable} unusable`}
      {run.costUsd > 0 && ` · $${run.costUsd.toFixed(5)}`}
      {run.trigger === 'scheduled' && ' · scheduled'}
      {run.fallbacks.length > 0 && (
        <span className="text-amber-700"> · {run.fallbacks.length} fell back to the local pipeline</span>
      )}
    </span>
  );
}

/** The "Run now" button for one source. */
export function RunSourceButton({
  sourceId, running, onRun,
}: {
  sourceId: string;
  running: boolean;
  onRun: (sourceId: string) => void;
}) {
  return (
    <Button size="sm" variant="outline" disabled={running} onClick={() => onRun(sourceId)}>
      <Play className="w-3.5 h-3.5" /> Run now
    </Button>
  );
}

/** §4.4: run every enabled source, with live progress. */
export function ScrapeAllControls({
  status, onRunAll,
}: {
  status: ScrapeStatus | null;
  onRunAll: () => void;
}) {
  const running = status?.running ?? false;
  const run = status?.run;

  return (
    <div className="mb-4 rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-bold">Scraping</p>
          <p className="text-sm text-muted-foreground">
            Fetch every enabled source now, instead of waiting for the scheduled time.
          </p>
        </div>
        <Button disabled={running} onClick={onRunAll}>
          <Play className="w-4 h-4" /> {running ? 'Running…' : 'Run all enabled'}
        </Button>
      </div>

      {running && run && (
        <p className="mt-3 text-sm" role="status">
          Fetching {run.currentSourceId ?? '…'} ({run.results.length} of {run.sourceIds.length} done).
          A full run can take a couple of minutes when the LLM is on.
        </p>
      )}

      {!running && run?.finishedAt && (
        <div className="mt-3">
          <Notice tone={run.summary.failed > 0 ? 'warn' : 'neutral'}>
            Finished: {run.summary.inserted} new article(s) across {run.sourceIds.length} source(s)
            {run.summary.failed > 0 && `, ${run.summary.failed} source(s) failed`}
            {run.summary.costUsd > 0 && ` · $${run.summary.costUsd.toFixed(5)}`}
            . New articles are waiting in the review queue.
          </Notice>
        </div>
      )}
    </div>
  );
}
