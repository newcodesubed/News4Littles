import { Card } from '../../../ui/Surface';
import type { HistoryEntry, PromptVersion } from './types';

/** §7.3: session run history — timestamped, click to reload. */
export function RunHistory({
  entries, onReload,
}: {
  entries: HistoryEntry[];
  onReload: (entry: HistoryEntry) => void;
}) {
  return (
    <Card>
      <h2 className="font-display text-xl mb-1">Run history</h2>
      <p className="text-sm text-muted-foreground mb-3">
        This browser session only. Click a run to load its prompt and result back.
      </p>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <button
                onClick={() => onReload(entry)}
                className="w-full rounded-2xl border border-border px-4 py-3 text-left text-sm hover:bg-muted"
              >
                <span className="font-bold">
                  {new Date(entry.at).toLocaleTimeString()} · {entry.target}
                  {entry.age !== null && ` age ${entry.age}`}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {entry.subjectHeadline.slice(0, 60)}
                  {' · '}
                  {entry.result.draft.engine === 'llm' ? (entry.result.draft.model ?? 'llm') : 'local-fallback'}
                  {entry.result.draft.costUsd !== undefined && ` · $${entry.result.draft.costUsd.toFixed(5)}`}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** §7.5: read-only version history, with a diff between any two. */
export function VersionHistory({
  versions, left, right, onSelect,
}: {
  versions: PromptVersion[];
  left: string;
  right: string;
  onSelect: (side: 'left' | 'right', id: string) => void;
}) {
  const find = (id: string) => versions.find((version) => version.id === id);
  const a = find(left);
  const b = find(right);

  return (
    <Card>
      <h2 className="font-display text-xl mb-1">Version history</h2>
      <p className="text-sm text-muted-foreground mb-3">
        Every promotion, kept permanently. Pick two to compare their text.
      </p>

      {versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing promoted yet.</p>
      ) : (
        <>
          <ol className="space-y-2 mb-4">
            {versions.map((version) => (
              <li key={version.id} className="rounded-2xl border border-border px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold">
                    v{version.version} · {version.target}
                    {version.age !== null && ` age ${version.age}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(version.promotedAt).toLocaleString()} by {version.promotedBy}
                  </span>
                </div>
                {version.note && <p className="mt-1 text-xs text-muted-foreground">{version.note}</p>}
                <div className="mt-2 flex gap-2 text-xs">
                  <button onClick={() => onSelect('left', version.id)}
                    className={`rounded-full px-2.5 py-1 font-bold ${left === version.id ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                    Compare as A
                  </button>
                  <button onClick={() => onSelect('right', version.id)}
                    className={`rounded-full px-2.5 py-1 font-bold ${right === version.id ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                    Compare as B
                  </button>
                </div>
              </li>
            ))}
          </ol>

          {a && b && a.id !== b.id && (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">
                  A · v{a.version}
                </p>
                <pre className="max-h-64 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                  {a.promptText}
                </pre>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">
                  B · v{b.version}
                </p>
                <pre className="max-h-64 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                  {b.promptText}
                </pre>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
