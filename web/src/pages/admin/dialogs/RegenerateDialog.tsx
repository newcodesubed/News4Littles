import { useState } from 'react';
import type { RegenerateJob } from '../../../admin/types';
import { Button } from '../../../ui/Button';
import { Modal } from './Modal';
import { changedFields, VersionDiff } from './VersionDiff';

/**
 * §4.2 Regenerate — every age version of one story, a tab each.
 *
 * Regeneration is story-scoped like publish and reject (§5), but APPLYING is
 * per-age: an editor who likes nine rewrites and not the tenth should be able
 * to take the nine. Ages a person has edited arrive unticked, so no human
 * wording is replaced unless someone chooses to replace it.
 */
export function RegenerateDialog({
  job,
  onDiscard,
  onApply,
}: {
  job: RegenerateJob;
  onDiscard: () => void;
  onApply: (ages: number[]) => void;
}) {
  const [active, setActive] = useState(job.versions[0].ageTarget);
  const [ticked, setTicked] = useState<Set<number>>(
    () => new Set(
      job.versions.filter((v) => !v.current.editedByHuman).map((v) => v.ageTarget),
    ),
  );

  const version = job.versions.find((v) => v.ageTarget === active) ?? job.versions[0];
  const changed = changedFields(version.current, version.generated);
  const plural = job.versions.length === 1 ? '' : 's';

  const toggle = (age: number) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(age)) next.delete(age);
      else next.add(age);
      return next;
    });

  return (
    <Modal title="Regenerate — review before applying" onClose={onDiscard} wide>
      <p className="text-sm text-muted-foreground">
        {job.versions.length} version{plural} re-run through the current guard config and
        prompts. Nothing has been saved yet. Preview cost ${job.costUsd.toFixed(4)}.
      </p>

      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Age versions">
          {job.versions.map((v) => {
            const count = changedFields(v.current, v.generated).length;
            const isActive = v.ageTarget === active;
            return (
              <span
                key={v.ageTarget}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-sm whitespace-nowrap ${
                  isActive ? 'border-primary bg-primary/10 font-bold' : 'border-border'
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={`Apply age ${v.ageTarget}`}
                  checked={ticked.has(v.ageTarget)}
                  onChange={() => toggle(v.ageTarget)}
                />
                <button role="tab" aria-selected={isActive} onClick={() => setActive(v.ageTarget)}>
                  Age {v.ageTarget}
                  {v.current.editedByHuman && <span aria-hidden="true"> ✎</span>}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {count === 0 ? '—' : `•${count}`}
                  </span>
                </button>
              </span>
            );
          })}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setTicked(
              ticked.size === 0 ? new Set(job.versions.map((v) => v.ageTarget)) : new Set(),
            )
          }
        >
          {ticked.size === 0 ? 'Tick all' : 'Untick all'}
        </Button>
      </div>

      <p className="mt-4 text-sm font-bold">
        Age {version.ageTarget}
        {version.current.editedByHuman && ' · edited by a person'}
        {' · '}
        {changed.length === 0
          ? 'no differences — applying this age would change nothing'
          : `${changed.length} field(s) would change`}
      </p>

      {version.fallbackReason && (
        <p className="mt-2 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
          This age fell back to the rule-based pipeline: {version.fallbackReason}
        </p>
      )}

      <VersionDiff current={version.current} generated={version.generated} />

      {version.current.editedByHuman && (
        <p className="mt-4 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
          ✎ This age was edited by a person. Tick it only if you want that wording replaced.
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-5">
        <Button variant="ghost" size="lg" onClick={onDiscard}>
          Discard
        </Button>
        <Button
          size="lg"
          disabled={ticked.size === 0}
          onClick={() => onApply([...ticked].sort((a, b) => a - b))}
        >
          Apply {ticked.size} of {job.versions.length} version{plural}
        </Button>
      </div>
    </Modal>
  );
}
