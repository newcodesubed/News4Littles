import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../../components/States';
import { useAdminAuth } from '../../admin/AdminAuthContext';
import { useAdminAction } from '../../admin/useAdminAction';
import { Notice } from '../../ui/Surface';
import { Modal } from './dialogs';
import { Button } from '../../ui/Button';
import { TextArea } from '../../ui/Field';
import { InputPanel } from './sandbox/InputPanel';
import { PromptEditor } from './sandbox/PromptEditor';
import { ResultsPanel } from './sandbox/ResultsPanel';
import { RunHistory, VersionHistory } from './sandbox/HistoryPanel';
import {
  versionKey,
  type HistoryEntry, type PromptsPayload, type PromptTarget,
  type PromptVersion, type RawArticleSummary, type TestResult,
} from './sandbox/types';

/**
 * /admin/sandbox — PRD §7.
 *
 * Three panels: what to test, the prompt, and the result. Nothing here writes
 * production data except Promote (§7.4).
 */
export function AdminSandbox() {
  const { adminFetch } = useAdminAuth();
  const [params] = useSearchParams();

  const [config, setConfig] = useState<PromptsPayload | null>(null);
  const [articles, setArticles] = useState<RawArticleSummary[]>([]);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [target, setTarget] = useState<PromptTarget>(
    params.get('target') === 'guard' ? 'guard' : 'simplification',
  );
  const [age, setAge] = useState<number | null>(
    params.get('age') ? Number(params.get('age')) : null,
  );
  // §7.2: "Open in sandbox" from a review row pre-loads that article.
  const [articleId, setArticleId] = useState(params.get('articleId') ?? '');
  const [rawText, setRawText] = useState('');
  const [headline, setHeadline] = useState('');

  const [promptText, setPromptText] = useState('');
  const [result, setResult] = useState<TestResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [note, setNote] = useState('');
  const [diffLeft, setDiffLeft] = useState('');
  const [diffRight, setDiffRight] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [promptsRes, articlesRes, versionsRes] = await Promise.all([
        adminFetch('/api/admin/prompts'),
        adminFetch('/api/admin/raw-articles?limit=40'),
        adminFetch('/api/admin/prompts/versions'),
      ]);
      if (!promptsRes.ok) throw new Error('Could not load the prompts.');

      setConfig((await promptsRes.json()) as PromptsPayload);
      if (articlesRes.ok) setArticles((await articlesRes.json()) as RawArticleSummary[]);
      if (versionsRes.ok) setVersions((await versionsRes.json()) as PromptVersion[]);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load the sandbox.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch]);

  useEffect(() => { void load(); }, [load]);

  const { notice, setNotice, run: act } = useAdminAction(load);

  /** The prompt currently live for this target+age. */
  const productionText = useMemo(() => {
    if (!config) return '';
    if (target === 'guard') return config.guard.promptText;
    if (age === null) return config.simplification.generic;
    return config.simplification.ageOverrides[String(age)] ?? config.simplification.generic;
  }, [config, target, age]);

  /** Load the draft if one exists, otherwise the live prompt (§7.3). */
  useEffect(() => {
    if (!config) return;
    const draft = config.drafts.find((d) => d.target === target && d.age === age);
    setPromptText(draft?.promptText ?? productionText);
    setResult(null);
  }, [config, target, age, productionText]);

  async function runTest(compareWithProduction: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await adminFetch('/api/admin/prompts/test', {
        method: 'POST',
        body: JSON.stringify({
          target, age, promptText, compareWithProduction,
          articleId: articleId || undefined,
          rawText: articleId ? undefined : rawText,
          headline: articleId ? undefined : headline,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        setNotice(`⚠ ${(body as { error?: string }).error ?? 'The test run failed.'}`);
        return;
      }

      const testResult = body as TestResult;
      setResult(testResult);
      setHistory((current) => [
        {
          at: new Date().toISOString(),
          target, age, promptSnapshot: promptText,
          subjectHeadline: testResult.subject.headline,
          result: testResult,
        },
        ...current,
      ].slice(0, 30));
    } catch {
      setNotice('⚠ Could not reach the server. Check it is running, then try again.');
    } finally {
      setBusy(false);
    }
  }

  // §7.4: promotion needs at least one successful test run this session.
  const canPromote = result !== null && !result.draft.fallbackReason;

  const sessionCost = history.reduce(
    (total, entry) => total + (entry.result.draft.costUsd ?? 0) + (entry.result.production?.costUsd ?? 0),
    0,
  );

  if (loading) return <div className="container max-w-6xl py-10"><LoadingState label="Loading the sandbox…" /></div>;
  if (error) return <div className="container max-w-6xl py-10"><ErrorState message={error} /></div>;
  if (!config) return null;

  const currentVersion = config.versions[versionKey(target, age)];

  return (
    <div className="container max-w-6xl py-10">
      <h1 className="font-display text-4xl mb-1">Prompt sandbox</h1>
      <p className="text-muted-foreground mb-6">
        Change a prompt and see what it does to a real article, without touching what readers see.
      </p>

      {!config.llm.enabled && (
        <div className="mb-5">
          <Notice tone="warn" role="alert">
            No LLM key is configured, so runs use the local rule-based pipeline and prompts have no
            effect on the output. Set OPENROUTER_KEY to test prompts for real.
          </Notice>
        </div>
      )}

      {notice && <div className="mb-5"><Notice>{notice}</Notice></div>}

      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>
          Live version: <strong>{currentVersion ? `v${currentVersion}` : 'never promoted'}</strong>
        </span>
        <span>·</span>
        <span>Model: <strong>{config.llm.enabled ? config.llm.model : 'local-fallback'}</strong></span>
        {sessionCost > 0 && (
          <>
            <span>·</span>
            <span>This session: <strong>${sessionCost.toFixed(5)}</strong></span>
          </>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <InputPanel
          target={target} age={age} articleId={articleId} rawText={rawText} headline={headline}
          articles={articles} defaultAge={config.defaultAge}
          onChange={(patch) => {
            if (patch.target !== undefined) setTarget(patch.target);
            if (patch.age !== undefined) setAge(patch.age);
            if (patch.articleId !== undefined) setArticleId(patch.articleId);
            if (patch.rawText !== undefined) setRawText(patch.rawText);
            if (patch.headline !== undefined) setHeadline(patch.headline);
          }}
        />

        <PromptEditor
          promptText={promptText}
          productionText={productionText}
          templateVariables={config.templateVariables}
          busy={busy}
          canPromote={canPromote}
          onChange={setPromptText}
          onRun={() => void runTest(false)}
          onCompare={() => void runTest(true)}
          onReset={() => { setPromptText(productionText); setResult(null); }}
          onSaveDraft={() =>
            void act('/api/admin/prompts/draft',
              { method: 'PUT', body: JSON.stringify({ target, age, promptText }) },
              'Draft saved. Production is unchanged.')}
          onPromote={() => setPromoting(true)}
        />
      </div>

      <div className="mt-5">
        <ResultsPanel result={result} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <RunHistory
          entries={history}
          onReload={(entry) => {
            setTarget(entry.target);
            setAge(entry.age);
            setPromptText(entry.promptSnapshot);
            setResult(entry.result);
          }}
        />
        <VersionHistory
          versions={versions} left={diffLeft} right={diffRight}
          onSelect={(side, id) => (side === 'left' ? setDiffLeft(id) : setDiffRight(id))}
        />
      </div>

      {promoting && (
        <Modal title="Promote to production" onClose={() => setPromoting(false)}>
          {/* §7.4: the dialog must summarise what will change. */}
          <p className="text-sm">This will make the edited prompt live for:</p>
          <ul className="mt-2 mb-4 text-sm font-bold">
            <li>• {target === 'guard' ? 'The safety guard' : 'Simplification'}</li>
            <li>• {age === null ? 'All ages (the generic prompt)' : `Age ${age} only`}</li>
            <li>• Version {currentVersion ? currentVersion + 1 : 1}</li>
          </ul>
          <p className="mb-4 text-sm text-muted-foreground">
            Articles already waiting for review are not regenerated. The next scrape, submission or
            regeneration uses the new prompt.
          </p>

          <label className="block">
            <span className="text-sm font-bold">Note (optional)</span>
            <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Why is this better?" />
          </label>

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="lg" onClick={() => setPromoting(false)}>Cancel</Button>
            <Button size="lg" onClick={() => {
              setPromoting(false);
              void act('/api/admin/prompts/promote', {
                method: 'POST',
                body: JSON.stringify({ target, age, promptText, note, confirmed: true }),
              }, 'Promoted. The next run uses this prompt.');
              setNote('');
            }}>
              Promote
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
