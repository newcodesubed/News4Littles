import { useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { AdminArticle } from '../../admin/types';

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/40 p-4 py-10"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`w-full ${wide ? 'max-w-5xl' : 'max-w-lg'} rounded-3xl bg-card shadow-card border border-border`}>
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="font-display text-xl">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 hover:bg-muted">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

/** §4.2: reject requires an optional free-text reason before confirming. */
export function RejectDialog({
  article,
  onCancel,
  onConfirm,
}: {
  article: AdminArticle;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <Modal title="Reject this story" onClose={onCancel}>
      <p className="font-bold">{article.kidHeadline}</p>
      <p className="mt-1 text-sm text-muted-foreground">{article.summary}</p>

      <label className="mt-5 block">
        <span className="text-sm font-bold">Reason (optional)</span>
        <p className="text-xs text-muted-foreground mb-1">
          Stored on the article, so anyone re-reviewing it later can see why.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          placeholder="e.g. Not really news for kids — corporate finance story."
          className="w-full rounded-xl border border-border bg-background px-4 py-2.5"
        />
      </label>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-full px-5 py-2.5 font-bold hover:bg-muted">
          Cancel
        </button>
        <button
          onClick={() => onConfirm(reason)}
          className="rounded-full bg-destructive px-5 py-2.5 font-bold text-white"
        >
          Reject
        </button>
      </div>
    </Modal>
  );
}

/** §4.2 Edit — every kid-facing field. Saving sets editedByHuman. */
export function EditDialog({
  article,
  onCancel,
  onSave,
}: {
  article: AdminArticle;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState({
    kidHeadline: article.kidHeadline,
    summary: article.summary,
    whatHappened: article.whatHappened,
    whyItMatters: article.whyItMatters,
    thinkAbout: article.thinkAbout,
    feelingNote: article.feelingNote ?? '',
    safety: article.safety,
    category: article.category,
    readingMinutes: article.readingMinutes,
    ageTarget: article.ageTarget,
    vocab: article.vocab,
  });

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const field = 'mt-1 w-full rounded-xl border border-border bg-background px-4 py-2.5';

  return (
    <Modal title="Edit story" onClose={onCancel} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="md:col-span-2 block">
          <span className="text-sm font-bold">Kid headline</span>
          <input value={draft.kidHeadline} onChange={(e) => set('kidHeadline', e.target.value)} className={field} />
        </label>

        <label className="md:col-span-2 block">
          <span className="text-sm font-bold">Summary</span>
          <textarea value={draft.summary} onChange={(e) => set('summary', e.target.value)} rows={2} className={field} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">What happened?</span>
          <textarea value={draft.whatHappened} onChange={(e) => set('whatHappened', e.target.value)} rows={5} className={field} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Why it matters</span>
          <textarea value={draft.whyItMatters} onChange={(e) => set('whyItMatters', e.target.value)} rows={5} className={field} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Think about</span>
          <textarea value={draft.thinkAbout} onChange={(e) => set('thinkAbout', e.target.value)} rows={3} className={field} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Feeling note</span>
          <p className="text-xs text-muted-foreground">Shown to readers only when safety is not “calm”.</p>
          <textarea value={draft.feelingNote} onChange={(e) => set('feelingNote', e.target.value)} rows={3} className={field} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Safety</span>
          <select value={draft.safety} onChange={(e) => set('safety', e.target.value as typeof draft.safety)} className={field}>
            <option value="calm">calm</option>
            <option value="adult-nearby">adult-nearby</option>
            <option value="skip-young">skip-young</option>
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-bold">Category</span>
          <input value={draft.category} onChange={(e) => set('category', e.target.value)} className={field} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Reading minutes</span>
          <input type="number" min={1} value={draft.readingMinutes}
            onChange={(e) => set('readingMinutes', Number(e.target.value))} className={field} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Age target</span>
          <input type="number" min={5} max={14} value={draft.ageTarget}
            onChange={(e) => set('ageTarget', Number(e.target.value))} className={field} />
        </label>

        <div className="md:col-span-2">
          <span className="text-sm font-bold">Words to know</span>
          <div className="mt-1 space-y-2">
            {draft.vocab.map((entry, index) => (
              <div key={index} className="flex flex-wrap gap-2">
                <input
                  value={entry.word}
                  aria-label={`Word ${index + 1}`}
                  onChange={(e) =>
                    set('vocab', draft.vocab.map((v, i) => (i === index ? { ...v, word: e.target.value } : v)))
                  }
                  className="w-40 rounded-xl border border-border bg-background px-3 py-2"
                />
                <input
                  value={entry.definition}
                  aria-label={`Definition ${index + 1}`}
                  onChange={(e) =>
                    set('vocab', draft.vocab.map((v, i) => (i === index ? { ...v, definition: e.target.value } : v)))
                  }
                  className="flex-1 min-w-48 rounded-xl border border-border bg-background px-3 py-2"
                />
                <button
                  onClick={() => set('vocab', draft.vocab.filter((_, i) => i !== index))}
                  className="rounded-full px-3 py-2 text-sm font-bold text-destructive hover:bg-muted"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              onClick={() => set('vocab', [...draft.vocab, { word: '', definition: '' }])}
              className="rounded-full border border-border px-4 py-2 text-sm font-bold hover:bg-muted"
            >
              + Add word
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-5">
        <button onClick={onCancel} className="rounded-full px-5 py-2.5 font-bold hover:bg-muted">
          Cancel
        </button>
        <button
          onClick={() =>
            onSave({
              ...draft,
              feelingNote: draft.feelingNote.trim() || null,
              vocab: draft.vocab.filter((v) => v.word.trim() && v.definition.trim()),
            })
          }
          className="rounded-full bg-primary px-5 py-2.5 font-bold text-primary-foreground shadow-pop"
        >
          Save changes
        </button>
      </div>
    </Modal>
  );
}

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
        <button onClick={onDiscard} className="rounded-full px-5 py-2.5 font-bold hover:bg-muted">
          Discard
        </button>
        <button onClick={onApply} className="rounded-full bg-primary px-5 py-2.5 font-bold text-primary-foreground shadow-pop">
          Apply regenerated version
        </button>
      </div>
    </Modal>
  );
}
