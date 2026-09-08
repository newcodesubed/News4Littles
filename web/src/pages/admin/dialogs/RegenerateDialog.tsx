import type { AdminArticle } from '../../../admin/types';
import { Button } from '../../../ui/Button';
import { Modal } from './Modal';

const DIFF_FIELDS = [
  'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'thinkAbout', 'feelingNote', 'safety', 'category', 'readingMinutes',
] as const;

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)';
  return String(value);
}

/** §4.2 Regenerate — before/after diff, explicit confirm, never silent. */
export function RegenerateDialog({
  current,
  generated,
  onDiscard,
  onApply,
}: {
  current: AdminArticle;
  generated: AdminArticle;
  onDiscard: () => void;
  onApply: () => void;
}) {
  const changed = DIFF_FIELDS.filter(
    (field) => String(current[field] ?? '') !== String(generated[field] ?? ''),
  );
  const vocabChanged =
    JSON.stringify(current.vocab) !== JSON.stringify(generated.vocab);

  return (
    <Modal title="Regenerate — review before applying" onClose={onDiscard} wide>
      <p className="text-sm text-muted-foreground">
        Re-run through the current guard config and prompts. Nothing has been saved yet.
      </p>
      <p className="mt-2 text-sm font-bold">
        {changed.length + (vocabChanged ? 1 : 0) === 0
          ? 'No differences — regenerating would change nothing.'
          : `${changed.length + (vocabChanged ? 1 : 0)} field(s) would change.`}
      </p>

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
            <tr className={`align-top border-t border-border ${vocabChanged ? '' : 'opacity-50'}`}>
              <td className="py-2 pr-4 font-bold">vocab</td>
              <td className={`py-2 pr-4 ${vocabChanged ? 'bg-destructive/10 rounded-lg px-2' : ''}`}>
                {current.vocab.map((v) => v.word).join(', ') || '(none)'}
              </td>
              <td className={`py-2 ${vocabChanged ? 'bg-safety-calm/15 rounded-lg px-2' : ''}`}>
                {generated.vocab.map((v) => v.word).join(', ') || '(none)'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {current.editedByHuman && (
        <p className="mt-4 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
          Careful: this story has been edited by a person. Applying will replace those edits.
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-5">
        <Button variant="ghost" size="lg" onClick={onDiscard}>
          Discard
        </Button>
        <Button size="lg" onClick={onApply}>
          Apply regenerated version
        </Button>
      </div>
    </Modal>
  );
}
