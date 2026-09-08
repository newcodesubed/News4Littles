import { Button } from '../../../ui/Button';
import { Card, Notice } from '../../../ui/Surface';

/** §7.3 panel 2: the prompt itself, plus what can be done with it. */
export function PromptEditor({
  promptText, productionText, templateVariables, busy, canPromote,
  onChange, onRun, onCompare, onReset, onSaveDraft, onPromote,
}: {
  promptText: string;
  productionText: string;
  templateVariables: string[];
  busy: boolean;
  canPromote: boolean;
  onChange: (text: string) => void;
  onRun: () => void;
  onCompare: () => void;
  onReset: () => void;
  onSaveDraft: () => void;
  onPromote: () => void;
}) {
  // §7.3: the editor always shows whether the text matches production.
  const matchesProduction = promptText.trim() === productionText.trim();

  /** Append a template variable at the end of the prompt. */
  const insert = (variable: string) => onChange(`${promptText}${promptText.endsWith('\n') ? '' : '\n'}${variable}`);

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl">2. Prompt</h2>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            matchesProduction ? 'bg-safety-calm/15 text-safety-calm' : 'bg-surface-sun text-amber-800'
          }`}
        >
          {matchesProduction ? 'Matches production' : 'Edited — not yet promoted'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Insert</span>
        {templateVariables.map((variable) => (
          <button
            key={variable}
            onClick={() => insert(variable)}
            className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs font-bold hover:bg-border"
          >
            {variable}
          </button>
        ))}
      </div>

      <textarea
        value={promptText}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Prompt text"
        rows={22}
        className="w-full rounded-xl border border-border bg-background px-4 py-3 font-mono text-xs leading-relaxed"
      />

      <div className="flex flex-wrap gap-2">
        <Button size="lg" onClick={onRun} disabled={busy || !promptText.trim()}>
          {busy ? 'Running…' : 'Run test'}
        </Button>
        <Button variant="outline" onClick={onCompare} disabled={busy || !promptText.trim()}>
          Compare with production
        </Button>
        <Button variant="outline" onClick={onReset} disabled={busy || matchesProduction}>
          Reset to production
        </Button>
        <Button variant="outline" onClick={onSaveDraft} disabled={busy || !promptText.trim()}>
          Save draft
        </Button>
        <Button variant="outline" onClick={onPromote} disabled={busy || !canPromote} className="ml-auto"
          title={canPromote ? undefined : 'Run a successful test first'}>
          Promote to production
        </Button>
      </div>

      {!canPromote && (
        <Notice tone="warn">
          Promotion needs one successful test run first, so nothing reaches readers untried.
        </Notice>
      )}
    </Card>
  );
}
