import { useState } from 'react';
import type { AdminArticle } from '../../../admin/types';
import { FIELD_CLASS, FIELD_CLASS_COMPACT } from '../../../ui/Field';
import { Button } from '../../../ui/Button';
import { Modal } from './Modal';

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


  return (
    <Modal title="Edit story" onClose={onCancel} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="md:col-span-2 block">
          <span className="text-sm font-bold">Kid headline</span>
          <input value={draft.kidHeadline} onChange={(e) => set('kidHeadline', e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="md:col-span-2 block">
          <span className="text-sm font-bold">Summary</span>
          <textarea value={draft.summary} onChange={(e) => set('summary', e.target.value)} rows={2} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">What happened?</span>
          <textarea value={draft.whatHappened} onChange={(e) => set('whatHappened', e.target.value)} rows={5} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Why it matters</span>
          <textarea value={draft.whyItMatters} onChange={(e) => set('whyItMatters', e.target.value)} rows={5} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Think about</span>
          <textarea value={draft.thinkAbout} onChange={(e) => set('thinkAbout', e.target.value)} rows={3} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Feeling note</span>
          <p className="text-xs text-muted-foreground">Shown to readers only when safety is not “calm”.</p>
          <textarea value={draft.feelingNote} onChange={(e) => set('feelingNote', e.target.value)} rows={3} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Safety</span>
          <select value={draft.safety} onChange={(e) => set('safety', e.target.value as typeof draft.safety)} className={`mt-1 ${FIELD_CLASS}`}>
            <option value="calm">calm</option>
            <option value="adult-nearby">adult-nearby</option>
            <option value="skip-young">skip-young</option>
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-bold">Category</span>
          <input value={draft.category} onChange={(e) => set('category', e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Reading minutes</span>
          <input type="number" min={1} value={draft.readingMinutes}
            onChange={(e) => set('readingMinutes', Number(e.target.value))} className={`mt-1 ${FIELD_CLASS}`} />
        </label>

        <label className="block">
          <span className="text-sm font-bold">Age target</span>
          <input type="number" min={5} max={14} value={draft.ageTarget}
            onChange={(e) => set('ageTarget', Number(e.target.value))} className={`mt-1 ${FIELD_CLASS}`} />
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
                  className={`w-40 ${FIELD_CLASS_COMPACT}`}
                />
                <input
                  value={entry.definition}
                  aria-label={`Definition ${index + 1}`}
                  onChange={(e) =>
                    set('vocab', draft.vocab.map((v, i) => (i === index ? { ...v, definition: e.target.value } : v)))
                  }
                  className={`flex-1 min-w-48 ${FIELD_CLASS_COMPACT}`}
                />
                <Button variant="danger" onClick={() => set('vocab', draft.vocab.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="outline" onClick={() => set('vocab', [...draft.vocab, { word: '', definition: '' }])}>
              + Add word
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-5">
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="lg"
          onClick={() =>
            onSave({
              ...draft,
              feelingNote: draft.feelingNote.trim() || null,
              vocab: draft.vocab.filter((v) => v.word.trim() && v.definition.trim()),
            })
          }
        >
          Save changes
        </Button>
      </div>
    </Modal>
  );
}
