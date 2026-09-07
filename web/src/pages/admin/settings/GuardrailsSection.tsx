import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { FIELD_CLASS_COMPACT } from '../../../ui/Field';
import { Notice, Section } from '../../../ui/Surface';
import type { GuardConfig, Save } from './types';

/** §6 deny-list editor. Changes reach the next guard run immediately. */
export function GuardrailsSection({ guard, save }: { guard: GuardConfig; save: Save }) {
  const [newWord, setNewWord] = useState('');

  const saveList = (changes: Partial<GuardConfig>, message: string) =>
    save('/api/admin/guard-config', { method: 'PUT', body: JSON.stringify({ ...guard, ...changes }) }, message);

  return (
    <Section
      title="Guardrails"
      blurb="The deny-list the safety guard checks every article against. Changes apply to the next guard run immediately — no restart needed."
      className="mb-6"
    >
      <label className="flex items-center gap-2 text-sm font-bold mb-4">
        <input
          type="checkbox"
          checked={guard.denyListEnabled}
          onChange={(e) => void saveList({ denyListEnabled: e.target.checked }, 'Guard updated.')}
        />
        Deny-list guard enabled
      </label>

      {!guard.denyListEnabled && (
        <div className="mb-4">
          <Notice tone="warn" role="alert">
            The guard is off. Every new article will be classified “calm”, whatever it says.
          </Notice>
        </div>
      )}

      <p className="text-xs text-muted-foreground mb-2">
        0 matches → calm · 1–2 → adult-nearby · 3+ → skip-young. Counted as distinct words.
      </p>

      <div className="flex flex-wrap gap-2">
        {guard.denyList.map((word) => (
          <span key={word} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-bold">
            {word}
            <button
              aria-label={`Remove ${word}`}
              onClick={() => void saveList({ denyList: guard.denyList.filter((w) => w !== word) }, 'Word removed.')}
              className="rounded-full p-0.5 hover:bg-background"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        ))}
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newWord.trim()) return;
          void saveList({ denyList: [...guard.denyList, newWord.trim()] }, 'Word added.');
          setNewWord('');
        }}
      >
        <input
          value={newWord}
          onChange={(e) => setNewWord(e.target.value)}
          placeholder="Add a word or phrase"
          aria-label="Add deny-list word"
          className={`${FIELD_CLASS_COMPACT} flex-1`}
        />
        <Button type="submit">Add</Button>
      </form>
    </Section>
  );
}
