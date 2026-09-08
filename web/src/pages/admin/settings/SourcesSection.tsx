import { useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { ConfirmDialog, type Confirmation } from '../dialogs';
import { FIELD_CLASS_COMPACT, Select, Switch } from '../../../ui/Field';
import { Section } from '../../../ui/Surface';
import { LastRunSummary, RunSourceButton, ScrapeAllControls } from './ScrapeControls';
import type { Save, ScrapeStatus, Source } from './types';

const TRUST_LEVELS = ['high', 'medium', 'low'] as const;
const blankDraft = { id: '', name: '', url: '', trustLevel: 'high', parser: 'rss', enabled: true };

/**
 * One editable source row.
 *
 * The inputs are CONTROLLED and revert on a failed save. They used to be
 * uncontrolled (defaultValue + onBlur), which meant a rejected PATCH left the
 * typed value sitting in the box while the database still held the old one —
 * the UI silently disagreed with the server.
 */
function SourceRow({
  source, save, status, onRun, onConfirm,
}: {
  source: Source;
  save: Save;
  status: ScrapeStatus | null;
  onRun: (sourceId: string) => void;
  onConfirm: (confirmation: Confirmation) => void;
}) {
  const [draft, setDraft] = useState(source);

  // Re-sync whenever the server's version of this row changes.
  useEffect(() => setDraft(source), [source]);

  /** Save one field; on failure put the server's value back. */
  const commit = async (field: keyof Source, value: string | boolean) => {
    if (value === source[field]) return;
    const ok = await save(
      `/api/admin/sources/${source.id}`,
      { method: 'PATCH', body: JSON.stringify({ [field]: value }) },
      'Source updated.',
    );
    if (!ok) setDraft(source);
  };

  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft.name}
              aria-label={`Name for ${source.id}`}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onBlur={(e) => void commit('name', e.target.value)}
              className={`${FIELD_CLASS_COMPACT} font-bold`}
            />
            <code className="rounded bg-muted px-2 py-1 text-xs">{source.id}</code>
            <span className="text-xs text-muted-foreground">{source.articleCount} article(s)</span>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={draft.url}
              aria-label={`Feed URL for ${source.id}`}
              placeholder="Feed URL"
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              onBlur={(e) => void commit('url', e.target.value)}
              className={`${FIELD_CLASS_COMPACT} min-w-64 flex-1 text-sm`}
            />
            <input
              value={draft.parser ?? ''}
              aria-label={`Parser for ${source.id}`}
              placeholder="parser (rss)"
              onChange={(e) => setDraft({ ...draft, parser: e.target.value })}
              onBlur={(e) => void commit('parser', e.target.value)}
              className={`${FIELD_CLASS_COMPACT} w-32 text-sm`}
            />
            <select
              value={draft.trustLevel}
              aria-label={`Trust level for ${source.id}`}
              onChange={(e) => {
                setDraft({ ...draft, trustLevel: e.target.value as Source['trustLevel'] });
                void commit('trustLevel', e.target.value);
              }}
              className={`${FIELD_CLASS_COMPACT} text-sm`}
            >
              {TRUST_LEVELS.map((level) => (
                <option key={level} value={level}>{level} trust</option>
              ))}
            </select>
          </div>

          {/* §4.4 "last-run results" — read-only scraper state. */}
          <p className="mt-2 text-xs text-muted-foreground">
            Last run: <LastRunSummary run={status?.lastRuns?.[source.id]} />
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Newest item seen:{' '}
            {source.lastFetchedItemPublishedAt
              ? new Date(source.lastFetchedItemPublishedAt).toLocaleString()
              : 'none'}
            <button
              onClick={() => onConfirm({
                title: `Re-check the whole ${source.name} feed?`,
                body: 'The next run will look at every item in the feed again, not just new ones. Stories already stored are still skipped, so nothing is duplicated.',
                confirmLabel: 'Reset',
                onConfirm: () => void save(`/api/admin/sources/${source.id}/reset-cursor`, { method: 'POST' }, 'Cursor reset.'),
              })}
              className="ml-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline"
            >
              <RotateCcw className="w-3 h-3" /> reset
            </button>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <RunSourceButton sourceId={source.id} running={status?.running ?? false} onRun={onRun} />
          <span className="flex items-center gap-2 text-sm font-bold">
            <Switch
              checked={draft.enabled}
              label={`Enable ${source.name}`}
              onChange={() => {
                setDraft({ ...draft, enabled: !draft.enabled });
                void commit('enabled', !draft.enabled);
              }}
            />
            Enabled
          </span>
          <Button
            variant="danger"
            aria-label={`Delete ${source.name}`}
            onClick={() => onConfirm({
              title: `Delete ${source.name}?`,
              body: source.articleCount > 0
                ? `${source.name} has ${source.articleCount} stored article(s), so it cannot be deleted. Turn it off instead — its stories stay readable and it stops being scraped.`
                : 'It will be removed from the sources list. Nothing else is affected.',
              confirmLabel: 'Delete',
              tone: 'danger',
              onConfirm: () => void save(`/api/admin/sources/${source.id}`, { method: 'DELETE' }, 'Source deleted.'),
            })}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SourcesSection({
  sources, save, status, onRun, onRunAll,
}: {
  sources: Source[];
  save: Save;
  status: ScrapeStatus | null;
  onRun: (sourceId: string) => void;
  onRunAll: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(blankDraft);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);

  return (
    <Section
      title="News sources"
      blurb="Feeds the scraper pulls from. Disable a source to stop scraping it while keeping its stories."
      className="mb-6"
    >
      <ScrapeAllControls status={status} onRunAll={onRunAll} />

      <div className="space-y-3">
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} save={save} status={status} onRun={onRun}
            onConfirm={setConfirming} />
        ))}
      </div>

      {adding ? (
        <div className="mt-4 rounded-2xl border-2 border-primary p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <input placeholder="id (slug, e.g. guardian)" value={draft.id}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })} className={FIELD_CLASS_COMPACT} />
            <input placeholder="Display name" value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={FIELD_CLASS_COMPACT} />
            <input placeholder="Feed URL" value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              className={`${FIELD_CLASS_COMPACT} sm:col-span-2`} />
            <input placeholder="parser (rss)" value={draft.parser}
              onChange={(e) => setDraft({ ...draft, parser: e.target.value })} className={FIELD_CLASS_COMPACT} />
            <Select value={draft.trustLevel} aria-label="Trust level"
              onChange={(e) => setDraft({ ...draft, trustLevel: e.target.value })} className="mt-0">
              {TRUST_LEVELS.map((level) => <option key={level} value={level}>{level} trust</option>)}
            </Select>
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              onClick={async () => {
                if (await save('/api/admin/sources', { method: 'POST', body: JSON.stringify(draft) }, 'Source added.')) {
                  setAdding(false);
                  setDraft(blankDraft);
                }
              }}
            >
              Add source
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="mt-4" onClick={() => setAdding(true)}>
          <Plus className="w-4 h-4" /> Add source
        </Button>
      )}

      {confirming && <ConfirmDialog confirmation={confirming} onCancel={() => setConfirming(null)} />}
    </Section>
  );
}
