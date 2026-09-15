import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../ui/Button';
import { FIELD_CLASS_COMPACT, Select } from '../../../ui/Field';
import { Notice, Section } from '../../../ui/Surface';
import { AGE_BANDS, ageBandLabel } from '../../../lib/ageBands';
import type { PromptConfig, Save } from './types';

/**
 * §8.5 prompt editor. Stored only — the local rule-based simplifier never reads
 * these, so nothing here changes output until LLM simplification exists.
 */
export function PromptsSection({ config, save }: { config: PromptConfig; save: Save }) {
  const [draft, setDraft] = useState(config);
  // Overrides are per reading group, keyed by the group's youngest age.
  const [newOverrideAge, setNewOverrideAge] = useState(String(AGE_BANDS[0]!.minAge));

  const persist = (next: Pick<PromptConfig, 'genericPrompt' | 'ageOverrides'>, message: string) =>
    save('/api/admin/prompt-config', { method: 'PUT', body: JSON.stringify(next) }, message);

  return (
    <Section
      title="Translation prompts"
      blurb="Instructions sent to an LLM when one is configured. Saved here, but they change nothing today — the local rule-based simplifier does not read them."
      className="mb-6"
    >
      <div className="mb-4">
        <Notice tone="warn">
          No LLM is wired up yet. These prompts are stored for later and have no effect on output
          until LLM simplification is built.
        </Notice>
      </div>

      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-bold">Generic prompt</span>
        <Link to="/admin/sandbox?target=simplification"
          className="text-sm font-semibold text-primary hover:underline">
          Test in sandbox →
        </Link>
      </div>
      <label className="block">
        <textarea
          aria-label="Generic prompt"
          value={draft.genericPrompt}
          rows={10}
          onChange={(e) => setDraft({ ...draft, genericPrompt: e.target.value })}
          className={`${FIELD_CLASS_COMPACT} mt-1 w-full font-mono text-xs`}
        />
      </label>

      <p className="mt-5 text-sm font-bold">Per-group overrides</p>
      {Object.keys(draft.ageOverrides).length === 0 && (
        <p className="text-sm text-muted-foreground">None. The generic prompt is used for every reading group.</p>
      )}

      {Object.entries(draft.ageOverrides).map(([age, text]) => (
        <div key={age} className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold">{ageBandLabel(Number(age))}</span>
            <Link to={`/admin/sandbox?target=simplification&age=${age}`}
              className="ml-auto mr-3 text-sm font-semibold text-primary hover:underline">
              Test in sandbox →
            </Link>
            <button
              onClick={() => {
                const ageOverrides = { ...draft.ageOverrides };
                delete ageOverrides[age];
                setDraft({ ...draft, ageOverrides });
                void persist({ genericPrompt: draft.genericPrompt, ageOverrides }, 'Override removed.');
              }}
              className="text-sm font-bold text-destructive hover:underline"
            >
              Remove
            </button>
          </div>
          <textarea
            value={text}
            rows={6}
            onChange={(e) =>
              setDraft({ ...draft, ageOverrides: { ...draft.ageOverrides, [age]: e.target.value } })
            }
            className={`${FIELD_CLASS_COMPACT} mt-1 w-full font-mono text-xs`}
          />
        </div>
      ))}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={newOverrideAge} aria-label="Override reading group" className="mt-0"
          onChange={(e) => setNewOverrideAge(e.target.value)}>
          {AGE_BANDS.map((band) => (
            <option key={band.minAge} value={band.minAge}>{ageBandLabel(band.minAge)}</option>
          ))}
        </Select>
        <Button
          variant="outline"
          onClick={() =>
            setDraft({
              ...draft,
              ageOverrides: {
                ...draft.ageOverrides,
                [newOverrideAge]: draft.ageOverrides[newOverrideAge] ?? draft.genericPrompt,
              },
            })
          }
        >
          Add override
        </Button>
        <Button size="lg"
          onClick={() => void persist({ genericPrompt: draft.genericPrompt, ageOverrides: draft.ageOverrides }, 'Prompts saved.')}>
          Save prompts
        </Button>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Version counters (read-only — only a sandbox promotion changes these):{' '}
        {Object.keys(config.versions).length === 0 ? 'none yet' : JSON.stringify(config.versions)}
      </p>
    </Section>
  );
}
