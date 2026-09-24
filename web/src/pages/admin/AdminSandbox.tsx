import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../../components/States';
import { useAdminAuth } from '../../admin/AdminAuthContext';
import { useAdminAction } from '../../admin/useAdminAction';
import { Notice } from '../../ui/Surface';
import { ConfirmDialog, Modal, type Confirmation } from './dialogs';
import { Button } from '../../ui/Button';
import { TextArea } from '../../ui/Field';
import { ageBandLabel } from '../../lib/ageBands';
import { InputPanel } from './sandbox/InputPanel';
import { PromptEditor } from './sandbox/PromptEditor';
import { ResultsPanel } from './sandbox/ResultsPanel';
import { RunHistory, VersionHistory } from './sandbox/HistoryPanel';
import { useRunHistory } from './sandbox/useRunHistory';
import {
  versionKey,
  type PromptsPayload, type PromptTarget,
  type PromptVersion, type RawArticleSummary, type TestResult,
} from './sandbox/types';

/** The prompt currently live for this target+age. */
function liveText(config: PromptsPayload, target: PromptTarget, age: number | null): string {
  if (target === 'guard') return config.guard.promptText;
  if (age === null) return config.simplification.generic;
  return config.simplification.ageOverrides[String(age)] ?? config.simplification.generic;
}

/** The draft if one exists, otherwise the live prompt (§7.3). */
function startingText(config: PromptsPayload, target: PromptTarget, age: number | null): string {
  const draft = config.drafts.find((d) => d.target === target && d.age === age);
  return draft?.promptText ?? liveText(config, target, age);
}

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
  /** The prompt text `result` came from, so an edit after the run is noticed. */
  const [testedText, setTestedText] = useState<string | null>(null);
  const [history, setHistory] = useRunHistory();
  const [busy, setBusy] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [note, setNote] = useState('');
  const [diffLeft, setDiffLeft] = useState('');
  const [diffRight, setDiffRight] = useState('');

  // "Open in sandbox" may name an article older than the 40 most recent.
  const linkedArticleId = params.get('articleId');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [promptsRes, articlesRes, versionsRes] = await Promise.all([
        adminFetch('/api/admin/prompts'),
        adminFetch(`/api/admin/raw-articles?${new URLSearchParams({
          limit: '40', ...(linkedArticleId ? { include: linkedArticleId } : {}),
        }).toString()}`),
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
  }, [adminFetch, linkedArticleId]);

  useEffect(() => { void load(); }, [load]);

  const { notice, setNotice, run: act } = useAdminAction(load);

  const productionText = useMemo(
    () => (config ? liveText(config, target, age) : ''),
    [config, target, age],
  );

  /** The saved draft for this prompt, which the editor opens instead of production. */
  const savedDraft = config?.drafts.find((d) => d.target === target && d.age === age) ?? null;

  const showProduction = () => { setPromptText(productionText); setResult(null); };

  /**
   * Resetting only the editor would leave the draft on the server, and it would
   * open again next visit. So a saved draft is deleted too, once confirmed.
   */
  function resetToProduction() {
    if (!savedDraft) { showProduction(); return; }

    const query = new URLSearchParams({ target });
    if (age !== null) query.set('age', String(age));
    setConfirming({
      title: 'Discard your saved draft?',
      body: `The draft saved ${new Date(savedDraft.updatedAt).toLocaleString()} is deleted, and the editor shows the production prompt.`,
      confirmLabel: 'Discard draft',
      tone: 'danger',
      onConfirm: () => void (async () => {
        if (await act(`/api/admin/prompts/draft?${query.toString()}`, { method: 'DELETE' },
          'Draft discarded. The editor shows the production prompt.')) showProduction();
      })(),
    });
  }

  // Only on the first config. Save draft and Promote reload it too, and
  // resetting then would throw away the text being worked on and the run
  // that makes it promotable. Switching prompt is handled where it happens.
  const seeded = useRef(false);
  useEffect(() => {
    if (!config || seeded.current) return;
    seeded.current = true;
    setPromptText(startingText(config, target, age));
    setResult(null);
  }, [config]);

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
      setTestedText(promptText);
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
  // §7.4: promote only what a successful run has actually tried.
  const promoteBlocker =
    result === null
      ? 'Promotion needs one successful test run first, so nothing reaches readers untried.'
      : result.draft.fallbackReason
        ? 'The last run fell back to the rule-based pipeline, so it does not count. Run it again.'
        : testedText !== promptText
          ? 'The prompt has changed since the last test. Run it again before promoting.'
          : null;

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
            const nextTarget = patch.target ?? target;
            const nextAge = patch.age !== undefined ? patch.age : age;
            if (nextTarget !== target || nextAge !== age) {
              setTarget(nextTarget);
              setAge(nextAge);
              setPromptText(startingText(config, nextTarget, nextAge));
              setResult(null);
            }
            if (patch.articleId !== undefined) setArticleId(patch.articleId);
            if (patch.rawText !== undefined) setRawText(patch.rawText);
            if (patch.headline !== undefined) setHeadline(patch.headline);
          }}
        />

        <PromptEditor
          promptText={promptText}
          productionText={productionText}
          draftSavedAt={savedDraft?.updatedAt ?? null}
          templateVariables={config.templateVariables}
          busy={busy}
          promoteBlocker={promoteBlocker}
          onChange={setPromptText}
          onRun={() => void runTest(false)}
          onCompare={() => void runTest(true)}
          onReset={resetToProduction}
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
            setTestedText(entry.promptSnapshot);
          }}
        />
        <VersionHistory
          versions={versions} left={diffLeft} right={diffRight}
          onSelect={(side, id) => (side === 'left' ? setDiffLeft(id) : setDiffRight(id))}
        />
      </div>

      {confirming && <ConfirmDialog confirmation={confirming} onCancel={() => setConfirming(null)} />}

      {promoting && (
        <Modal title="Promote to production" onClose={() => setPromoting(false)}>
          {/* §7.4: the dialog must summarise what will change. */}
          <p className="text-sm">This will make the edited prompt live for:</p>
          <ul className="mt-2 mb-4 text-sm font-bold">
            <li>• {target === 'guard' ? 'The safety guard' : 'Simplification'}</li>
            <li>• {age === null ? 'All ages (the generic prompt)' : `${ageBandLabel(age)} only`}</li>
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
