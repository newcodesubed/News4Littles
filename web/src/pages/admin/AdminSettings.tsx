import { useCallback, useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { ErrorState, LoadingState } from '../../components/States';
import { useAdminAuth } from '../../admin/AdminAuthContext';

/**
 * Admin settings — PRD §4.4 (§5.1 sources, §6 guardrails, §8.5 prompts, §8.7 app).
 *
 * No LLM calls anywhere on this page. The prompt fields below are stored only;
 * nothing reads them until §9.1 exists.
 */
interface Source {
  id: string; name: string; url: string; enabled: boolean;
  trustLevel: 'high' | 'medium' | 'low'; parser: string | null;
  lastFetchedAt: string | null; lastFetchedItemPublishedAt: string | null;
  articleCount: number;
}
interface GuardConfig { denyList: string[]; denyListEnabled: boolean; promptGuardEnabled: boolean; promptGuardText: string }
interface PromptConfig { genericPrompt: string; ageOverrides: Record<string, string>; versions: Record<string, number> }
interface AppSettings { defaultAge: number; scrapeTimes: string[]; llmProvider: string | null; apiKeyLocation: string }

const field = 'rounded-xl border border-border bg-background px-3 py-2';
const card = 'rounded-3xl border border-border bg-card p-6 shadow-soft';

function Section({ title, blurb, children }: { title: string; blurb?: string; children: React.ReactNode }) {
  return (
    <section className={`${card} mb-6`}>
      <h2 className="font-display text-2xl mb-1">{title}</h2>
      {blurb && <p className="text-sm text-muted-foreground mb-4">{blurb}</p>}
      {children}
    </section>
  );
}

export function AdminSettings() {
  const { adminFetch } = useAdminAuth();

  const [sources, setSources] = useState<Source[] | null>(null);
  const [guard, setGuard] = useState<GuardConfig | null>(null);
  const [prompts, setPrompts] = useState<PromptConfig | null>(null);
  const [app, setApp] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newWord, setNewWord] = useState('');
  const [newTime, setNewTime] = useState('');
  const [newOverrideAge, setNewOverrideAge] = useState('7');
  const [adding, setAdding] = useState(false);
  const [draftSource, setDraftSource] = useState({ id: '', name: '', url: '', trustLevel: 'high', parser: 'rss', enabled: true });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, g, p, a] = await Promise.all([
        adminFetch('/api/admin/sources'),
        adminFetch('/api/admin/guard-config'),
        adminFetch('/api/admin/prompt-config'),
        adminFetch('/api/admin/app-settings'),
      ]);
      if (!s.ok || !g.ok || !p.ok || !a.ok) throw new Error('Could not load settings.');
      setSources(await s.json()); setGuard(await g.json());
      setPrompts(await p.json()); setApp(await a.json());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch]);

  useEffect(() => { void load(); }, [load]);

  async function send(path: string, init: RequestInit, message: string) {
    setNotice(null);
    const res = await adminFetch(path, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(`⚠ ${body.error ?? `Failed (${res.status}).`}`);
      return false;
    }
    setNotice(message);
    await load();
    return true;
  }

  if (loading) return <div className="container max-w-4xl py-10"><LoadingState label="Loading settings…" /></div>;
  if (error) return <div className="container max-w-4xl py-10"><ErrorState message={error} /></div>;
  if (!sources || !guard || !prompts || !app) return null;

  return (
    <div className="container max-w-4xl py-10">
      <h1 className="font-display text-4xl mb-1">Settings</h1>
      <p className="text-muted-foreground mb-6">Sources, guardrails, prompts and app defaults.</p>

      {notice && <p role="status" className="mb-5 rounded-2xl bg-muted px-4 py-3 text-sm font-semibold">{notice}</p>}

      {/* ── §5.1 sources CRUD ───────────────────────────────────────────── */}
      <Section title="News sources" blurb="Feeds the scraper pulls from. Disable a source to stop scraping it while keeping its stories.">
        <div className="space-y-3">
          {sources.map((source) => (
            <div key={source.id} className="rounded-2xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input defaultValue={source.name} aria-label={`Name for ${source.id}`}
                      onBlur={(e) => e.target.value !== source.name && send(`/api/admin/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ name: e.target.value }) }, 'Source updated.')}
                      className={`${field} font-bold`} />
                    <code className="rounded bg-muted px-2 py-1 text-xs">{source.id}</code>
                    <span className="text-xs text-muted-foreground">{source.articleCount} article(s)</span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2">
                    <input defaultValue={source.url} aria-label={`Feed URL for ${source.id}`} placeholder="Feed URL"
                      onBlur={(e) => e.target.value !== source.url && send(`/api/admin/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ url: e.target.value }) }, 'Source updated.')}
                      className={`${field} min-w-64 flex-1 text-sm`} />
                    <input defaultValue={source.parser ?? ''} aria-label={`Parser for ${source.id}`} placeholder="parser (rss)"
                      onBlur={(e) => e.target.value !== (source.parser ?? '') && send(`/api/admin/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ parser: e.target.value }) }, 'Source updated.')}
                      className={`${field} w-32 text-sm`} />
                    <select defaultValue={source.trustLevel} aria-label={`Trust level for ${source.id}`}
                      onChange={(e) => send(`/api/admin/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ trustLevel: e.target.value }) }, 'Source updated.')}
                      className={`${field} text-sm`}>
                      <option value="high">high trust</option>
                      <option value="medium">medium trust</option>
                      <option value="low">low trust</option>
                    </select>
                  </div>

                  {/* §4.4 "last-run results" — read-only scraper state. */}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Last fetched: {source.lastFetchedAt ? new Date(source.lastFetchedAt).toLocaleString() : 'never'}
                    {' · '}newest item seen:{' '}
                    {source.lastFetchedItemPublishedAt ? new Date(source.lastFetchedItemPublishedAt).toLocaleString() : 'none'}
                    <button
                      onClick={() => { if (window.confirm(`Reset the scrape cursor for ${source.name}? The next run will re-check every item in the feed.`)) void send(`/api/admin/sources/${source.id}/reset-cursor`, { method: 'POST' }, 'Cursor reset.'); }}
                      className="ml-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                      <RotateCcw className="w-3 h-3" /> reset
                    </button>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-sm font-bold">
                    <input type="checkbox" checked={source.enabled} aria-label={`Enable ${source.name}`}
                      onChange={(e) => send(`/api/admin/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) }, 'Source updated.')} />
                    Enabled
                  </label>
                  <button
                    onClick={() => { if (window.confirm(`Delete ${source.name}?`)) void send(`/api/admin/sources/${source.id}`, { method: 'DELETE' }, 'Source deleted.'); }}
                    aria-label={`Delete ${source.name}`}
                    className="rounded-full p-2 text-destructive hover:bg-muted">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {adding ? (
          <div className="mt-4 rounded-2xl border-2 border-primary p-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <input placeholder="id (slug, e.g. guardian)" value={draftSource.id}
                onChange={(e) => setDraftSource({ ...draftSource, id: e.target.value })} className={field} />
              <input placeholder="Display name" value={draftSource.name}
                onChange={(e) => setDraftSource({ ...draftSource, name: e.target.value })} className={field} />
              <input placeholder="Feed URL" value={draftSource.url}
                onChange={(e) => setDraftSource({ ...draftSource, url: e.target.value })} className={`${field} sm:col-span-2`} />
              <input placeholder="parser (rss)" value={draftSource.parser}
                onChange={(e) => setDraftSource({ ...draftSource, parser: e.target.value })} className={field} />
              <select value={draftSource.trustLevel} aria-label="Trust level"
                onChange={(e) => setDraftSource({ ...draftSource, trustLevel: e.target.value })} className={field}>
                <option value="high">high trust</option><option value="medium">medium trust</option><option value="low">low trust</option>
              </select>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={async () => { if (await send('/api/admin/sources', { method: 'POST', body: JSON.stringify(draftSource) }, 'Source added.')) { setAdding(false); setDraftSource({ id: '', name: '', url: '', trustLevel: 'high', parser: 'rss', enabled: true }); } }}
                className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">Add source</button>
              <button onClick={() => setAdding(false)} className="rounded-full px-4 py-2 text-sm font-bold hover:bg-muted">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="mt-4 inline-flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-bold hover:bg-muted">
            <Plus className="w-4 h-4" /> Add source
          </button>
        )}
      </Section>

      {/* ── §6 guardrails ───────────────────────────────────────────────── */}
      <Section title="Guardrails" blurb="The deny-list the safety guard checks every article against. Changes apply to the next guard run immediately — no restart needed.">
        <label className="flex items-center gap-2 text-sm font-bold mb-4">
          <input type="checkbox" checked={guard.denyListEnabled}
            onChange={(e) => send('/api/admin/guard-config', { method: 'PUT', body: JSON.stringify({ ...guard, denyListEnabled: e.target.checked }) }, 'Guard updated.')} />
          Deny-list guard enabled
        </label>
        {!guard.denyListEnabled && (
          <p className="mb-4 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
            The guard is off. Every new article will be classified “calm”, whatever it says.
          </p>
        )}

        <p className="text-xs text-muted-foreground mb-2">
          0 matches → calm · 1–2 → adult-nearby · 3+ → skip-young. Counted as distinct words.
        </p>
        <div className="flex flex-wrap gap-2">
          {guard.denyList.map((word) => (
            <span key={word} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-bold">
              {word}
              <button aria-label={`Remove ${word}`}
                onClick={() => send('/api/admin/guard-config', { method: 'PUT', body: JSON.stringify({ ...guard, denyList: guard.denyList.filter((w) => w !== word) }) }, 'Word removed.')}
                className="rounded-full p-0.5 hover:bg-background"><X className="w-3.5 h-3.5" /></button>
            </span>
          ))}
        </div>

        <form className="mt-4 flex gap-2"
          onSubmit={(e) => { e.preventDefault(); if (!newWord.trim()) return;
            void send('/api/admin/guard-config', { method: 'PUT', body: JSON.stringify({ ...guard, denyList: [...guard.denyList, newWord.trim()] }) }, 'Word added.');
            setNewWord(''); }}>
          <input value={newWord} onChange={(e) => setNewWord(e.target.value)} placeholder="Add a word or phrase"
            aria-label="Add deny-list word" className={`${field} flex-1`} />
          <button type="submit" className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">Add</button>
        </form>
      </Section>

      {/* ── §8.5 translation prompts ────────────────────────────────────── */}
      <Section title="Translation prompts"
        blurb="Instructions sent to an LLM when one is configured. Saved here, but they change nothing today — the local rule-based simplifier does not read them.">
        <p className="mb-4 rounded-2xl bg-surface-sun px-4 py-3 text-sm font-semibold">
          No LLM is wired up yet. These prompts are stored for later and have no effect on output
          until LLM simplification is built.
        </p>

        <label className="block">
          <span className="text-sm font-bold">Generic prompt</span>
          <textarea defaultValue={prompts.genericPrompt} rows={10} id="genericPrompt"
            onChange={(e) => setPrompts({ ...prompts, genericPrompt: e.target.value })}
            className={`${field} mt-1 w-full font-mono text-xs`} />
        </label>

        <p className="mt-5 text-sm font-bold">Per-age overrides</p>
        {Object.entries(prompts.ageOverrides).length === 0 && (
          <p className="text-sm text-muted-foreground">None. The generic prompt is used for every age.</p>
        )}
        {Object.entries(prompts.ageOverrides).map(([age, text]) => (
          <div key={age} className="mt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold">Age {age}</span>
              <button onClick={() => { const next = { ...prompts.ageOverrides }; delete next[age];
                  void send('/api/admin/prompt-config', { method: 'PUT', body: JSON.stringify({ genericPrompt: prompts.genericPrompt, ageOverrides: next }) }, 'Override removed.'); }}
                className="text-sm font-bold text-destructive hover:underline">Remove</button>
            </div>
            <textarea defaultValue={text} rows={6}
              onChange={(e) => setPrompts({ ...prompts, ageOverrides: { ...prompts.ageOverrides, [age]: e.target.value } })}
              className={`${field} mt-1 w-full font-mono text-xs`} />
          </div>
        ))}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select value={newOverrideAge} onChange={(e) => setNewOverrideAge(e.target.value)} aria-label="Override age" className={field}>
            {Array.from({ length: 10 }, (_, i) => i + 5).map((a) => <option key={a} value={a}>Age {a}</option>)}
          </select>
          <button
            onClick={() => setPrompts({ ...prompts, ageOverrides: { ...prompts.ageOverrides, [newOverrideAge]: prompts.ageOverrides[newOverrideAge] ?? prompts.genericPrompt } })}
            className="rounded-full border border-border px-4 py-2 text-sm font-bold hover:bg-muted">Add override</button>

          <button
            onClick={() => send('/api/admin/prompt-config', { method: 'PUT', body: JSON.stringify({ genericPrompt: prompts.genericPrompt, ageOverrides: prompts.ageOverrides }) }, 'Prompts saved.')}
            className="rounded-full bg-primary px-5 py-2 text-sm font-bold text-primary-foreground shadow-pop">Save prompts</button>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Version counters (read-only — only a sandbox promotion changes these):{' '}
          {Object.keys(prompts.versions).length === 0 ? 'none yet' : JSON.stringify(prompts.versions)}
        </p>
      </Section>

      {/* ── §8.7 app settings ───────────────────────────────────────────── */}
      <Section title="App settings">
        <label className="block max-w-xs">
          <span className="text-sm font-bold">Default reading age</span>
          <input type="number" min={5} max={14} value={app.defaultAge}
            onChange={(e) => setApp({ ...app, defaultAge: Number(e.target.value) })} className={`${field} mt-1 w-full`} />
        </label>

        <p className="mt-5 text-sm font-bold">Scrape times</p>
        <p className="text-xs text-muted-foreground mb-2">
          When the scraper runs each day. Changes take effect when the server restarts.
        </p>
        <div className="flex flex-wrap gap-2">
          {app.scrapeTimes.map((time) => (
            <span key={time} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-bold">
              {time}
              <button aria-label={`Remove ${time}`} onClick={() => setApp({ ...app, scrapeTimes: app.scrapeTimes.filter((t) => t !== time) })}
                className="rounded-full p-0.5 hover:bg-background"><X className="w-3.5 h-3.5" /></button>
            </span>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} aria-label="Add scrape time" className={field} />
          <button onClick={() => { if (newTime) { setApp({ ...app, scrapeTimes: [...app.scrapeTimes, newTime] }); setNewTime(''); } }}
            className="rounded-full border border-border px-4 py-2 text-sm font-bold hover:bg-muted">Add time</button>
        </div>

        <label className="mt-5 block max-w-xs">
          <span className="text-sm font-bold">LLM provider</span>
          <select value={app.llmProvider ?? ''} onChange={(e) => setApp({ ...app, llmProvider: e.target.value || null })} className={`${field} mt-1 w-full`}>
            <option value="">none (local fallback)</option>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          API key: {app.apiKeyLocation}. Setting a provider here does not enable LLM
          simplification — that integration does not exist yet.
        </p>

        <button
          onClick={() => send('/api/admin/app-settings', { method: 'PUT', body: JSON.stringify(app) }, 'App settings saved.')}
          className="mt-5 rounded-full bg-primary px-5 py-2.5 font-bold text-primary-foreground shadow-pop">Save app settings</button>
      </Section>
    </div>
  );
}
