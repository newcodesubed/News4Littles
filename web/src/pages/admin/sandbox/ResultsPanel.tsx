import { StoryPreview } from '../../../components/StoryPreview';
import { Card, Notice } from '../../../ui/Surface';
import type { SandboxRun, TestResult } from './types';

const DIFF_FIELDS = [
  'kidHeadline', 'summary', 'whatHappened', 'whyItMatters',
  'thinkAbout', 'feelingNote', 'safety', 'readingMinutes',
] as const;

/** §7.4: elapsed time, and which engine produced the output. */
function RunMeta({ run }: { run: SandboxRun }) {
  return (
    <p className="text-xs text-muted-foreground">
      model: <strong>{run.engine === 'llm' ? (run.model ?? 'llm') : 'local-fallback'}</strong>
      {run.elapsedMs !== undefined && ` · ${run.elapsedMs}ms`}
      {run.costUsd !== undefined && ` · $${run.costUsd.toFixed(5)}`}
    </p>
  );
}

/** §7.3: schema validity, parse errors, and words per sentence vs the age. */
function Validation({ run }: { run: SandboxRun }) {
  if (!run.validation) return null;
  const v = run.validation;

  return (
    <div className="rounded-2xl bg-muted px-4 py-3 text-sm">
      <p className="font-bold">
        {v.schemaValid ? 'Schema valid' : 'Could not use the response'}
        {' · '}
        {v.withinAgeLimit
          ? `sentences within the age limit (${v.longestSentenceWords}/${v.ageLimit} words)`
          : `longest sentence is ${v.longestSentenceWords} words, over the ${v.ageLimit}-word limit`}
      </p>
      {v.parseError && <p className="mt-1 text-muted-foreground">{v.parseError}</p>}
      {v.overLongSentences.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {v.overLongSentences.slice(0, 3).map((sentence) => (
            <li key={sentence}>• {sentence}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GuardResult({ run }: { run: SandboxRun }) {
  return (
    <div className="space-y-3">
      <p className="font-display text-2xl">
        Verdict: {run.guardVerdict ?? <span className="text-destructive">unreadable</span>}
      </p>
      {run.fallbackReason && <Notice tone="warn">{run.fallbackReason}</Notice>}
      <div>
        <p className="text-sm font-bold mb-1">The guard's raw response</p>
        <pre className="overflow-x-auto rounded-xl bg-muted px-4 py-3 font-mono text-xs">
          {run.guardRaw || '(empty)'}
        </pre>
      </div>
    </div>
  );
}

function Run({ run, label }: { run: SandboxRun; label?: string }) {
  return (
    <div className="space-y-4">
      {label && <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p>}
      <RunMeta run={run} />
      {run.fallbackReason && run.target === 'simplification' && (
        <Notice tone="warn">Fell back to the rule-based pipeline: {run.fallbackReason}</Notice>
      )}
      <Validation run={run} />
      {run.target === 'guard' ? (
        <GuardResult run={run} />
      ) : (
        run.article && <StoryPreview article={run.article} showSource={false} headingLevel="h2" />
      )}
    </div>
  );
}

/** §7.3 comparison mode: field-level diff between production and the draft. */
function Diff({ production, draft }: { production: SandboxRun; draft: SandboxRun }) {
  if (!production.article || !draft.article) return null;
  const a = production.article;
  const b = draft.article;

  const changed = DIFF_FIELDS.filter((f) => String(a[f] ?? '') !== String(b[f] ?? ''));
  const vocabChanged = JSON.stringify(a.vocab) !== JSON.stringify(b.vocab);
  const total = changed.length + (vocabChanged ? 1 : 0);

  return (
    <div className="mb-6">
      <p className="mb-2 text-sm font-bold">
        {total === 0 ? 'No differences — the draft produced the same output.' : `${total} field(s) differ.`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="pb-2 pr-4">Field</th>
              <th className="pb-2 pr-4 w-1/2">Production</th>
              <th className="pb-2 w-1/2">Draft</th>
            </tr>
          </thead>
          <tbody>
            {DIFF_FIELDS.map((field) => {
              const isChanged = changed.includes(field);
              return (
                <tr key={field} className={`align-top border-t border-border ${isChanged ? '' : 'opacity-50'}`}>
                  <td className="py-2 pr-4 font-bold whitespace-nowrap">{field}</td>
                  <td className={`py-2 pr-4 ${isChanged ? 'bg-destructive/10 rounded-lg px-2' : ''}`}>
                    {String(a[field] ?? '(none)')}
                  </td>
                  <td className={`py-2 ${isChanged ? 'bg-safety-calm/15 rounded-lg px-2' : ''}`}>
                    {String(b[field] ?? '(none)')}
                  </td>
                </tr>
              );
            })}
            <tr className={`align-top border-t border-border ${vocabChanged ? '' : 'opacity-50'}`}>
              <td className="py-2 pr-4 font-bold">vocab</td>
              <td className={`py-2 pr-4 ${vocabChanged ? 'bg-destructive/10 rounded-lg px-2' : ''}`}>
                {a.vocab.map((v) => v.word).join(', ') || '(none)'}
              </td>
              <td className={`py-2 ${vocabChanged ? 'bg-safety-calm/15 rounded-lg px-2' : ''}`}>
                {b.vocab.map((v) => v.word).join(', ') || '(none)'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** §7.3 panel 3: the output, rendered as a reader would see it. */
export function ResultsPanel({ result }: { result: TestResult | null }) {
  if (!result) {
    return (
      <Card>
        <h2 className="font-display text-xl mb-2">3. Result</h2>
        <p className="text-muted-foreground">
          Run a test to see the output here, rendered the way a reader would see it.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="font-display text-xl mb-3">3. Result</h2>

      {result.usingLocalFallback && (
        <div className="mb-4">
          <Notice tone="warn">
            No LLM is answering, so this ran the local rule-based pipeline. The prompt had no effect
            on this output.
          </Notice>
        </div>
      )}

      {result.production && <Diff production={result.production} draft={result.draft} />}

      <div className={result.production ? 'grid gap-8 lg:grid-cols-2' : ''}>
        {result.production && <Run run={result.production} label="Production prompt" />}
        <Run run={result.draft} label={result.production ? 'Draft prompt' : undefined} />
      </div>
    </Card>
  );
}
