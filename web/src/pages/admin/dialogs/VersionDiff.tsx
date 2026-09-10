import type { AdminArticle } from '../../../admin/types';

/** The kid-facing fields §4.2 lets a regeneration replace. */
export const DIFF_FIELDS = [
  'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'thinkAbout', 'feelingNote', 'safety', 'category', 'readingMinutes',
] as const;

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)';
  return String(value);
}

/** Which fields differ, with vocab counted as one. */
export function changedFields(current: AdminArticle, generated: AdminArticle): string[] {
  const changed: string[] = DIFF_FIELDS.filter(
    (field) => String(current[field] ?? '') !== String(generated[field] ?? ''),
  );
  if (JSON.stringify(current.vocab) !== JSON.stringify(generated.vocab)) changed.push('vocab');
  return changed;
}

/**
 * One age's before/after. Unchanged rows stay on screen at half opacity: an
 * editor deciding whether to take a rewrite needs to see what it leaves alone.
 */
export function VersionDiff({
  current, generated,
}: {
  current: AdminArticle;
  generated: AdminArticle;
}) {
  const changed = changedFields(current, generated);

  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="pb-2 pr-4">Field</th>
            <th className="pb-2 pr-4 w-1/2">Current</th>
            <th className="pb-2 w-1/2">Regenerated</th>
          </tr>
        </thead>
        <tbody>
          {DIFF_FIELDS.map((f) => {
            const isChanged = changed.includes(f);
            return (
              <tr key={f} className={`align-top border-t border-border ${isChanged ? '' : 'opacity-50'}`}>
                <td className="py-2 pr-4 font-bold whitespace-nowrap">{f}</td>
                <td className={`py-2 pr-4 ${isChanged ? 'bg-destructive/10 rounded-lg px-2' : ''}`}>
                  {display(current[f])}
                </td>
                <td className={`py-2 ${isChanged ? 'bg-safety-calm/15 rounded-lg px-2' : ''}`}>
                  {display(generated[f])}
                </td>
              </tr>
            );
          })}
          <tr className={`align-top border-t border-border ${changed.includes('vocab') ? '' : 'opacity-50'}`}>
            <td className="py-2 pr-4 font-bold">vocab</td>
            <td className={`py-2 pr-4 ${changed.includes('vocab') ? 'bg-destructive/10 rounded-lg px-2' : ''}`}>
              {current.vocab.map((v) => v.word).join(', ') || '(none)'}
            </td>
            <td className={`py-2 ${changed.includes('vocab') ? 'bg-safety-calm/15 rounded-lg px-2' : ''}`}>
              {generated.vocab.map((v) => v.word).join(', ') || '(none)'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
