import { useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { FIELD_CLASS_COMPACT, Select, Switch } from '../../../ui/Field';
import { Section } from '../../../ui/Surface';
import type { Save, Source } from './types';

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
function SourceRow({ source, save }: { source: Source; save: Save }) {
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

          {/* §4.4 calls these "last-run results" — scraper state, read-only. */}
          <p className="mt-2 text-xs text-muted-foreground">
            Last fetched: {source.lastFetchedAt ? new Date(source.lastFetchedAt).toLocaleString() : 'never'}
            {' · '}newest item seen:{' '}
            {source.lastFetchedItemPublishedAt
              ? new Date(source.lastFetchedItemPublishedAt).toLocaleString()
              : 'none'}
            <button
              onClick={() => {
                if (window.confirm(`Reset the scrape cursor for ${source.name}? The next run will re-check every item in the feed.`)) {
                  void save(`/api/admin/sources/${source.id}/reset-cursor`, { method: 'POST' }, 'Cursor reset.');
                }
              }}
              className="ml-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline"
            >
              <RotateCcw className="w-3 h-3" /> reset
            </button>
          </p>
        </div>

        <div className="flex items-center gap-2">
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
            onClick={() => {
              if (window.confirm(`Delete ${source.name}?`)) {
                void save(`/api/admin/sources/${source.id}`, { method: 'DELETE' }, 'Source deleted.');
              }
            }}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SourcesSection({ sources, save }: { sources: Source[]; save: Save }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(blankDraft);

  return (
    <Section
      title="News sources"
      blurb="Feeds the scraper pulls from. Disable a source to stop scraping it while keeping its stories."
      className="mb-6"
    >
      <div className="space-y-3">
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} save={save} />
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
    </Section>
  );
}
