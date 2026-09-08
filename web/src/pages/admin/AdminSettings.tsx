import { useCallback, useEffect, useState } from 'react';
import { ErrorState, LoadingState } from '../../components/States';
import { useAdminAuth } from '../../admin/AdminAuthContext';
import { useAdminAction } from '../../admin/useAdminAction';
import { Notice } from '../../ui/Surface';
import { AppSettingsSection } from './settings/AppSettingsSection';
import { GuardrailsSection } from './settings/GuardrailsSection';
import { PromptsSection } from './settings/PromptsSection';
import { SourcesSection } from './settings/SourcesSection';
import type { AppSettings, GuardConfig, PromptConfig, ScrapeStatus, Source } from './settings/types';

/**
 * Admin settings — PRD §4.4. This file loads the four config blocks and hands
 * each to its own section; the sections own their editing.
 *
 * No LLM calls anywhere on this page.
 */
interface SettingsData {
  sources: Source[];
  guard: GuardConfig;
  prompts: PromptConfig;
  app: AppSettings;
}

export function AdminSettings() {
  const { adminFetch } = useAdminAuth();
  const [data, setData] = useState<SettingsData | null>(null);
  const [scrape, setScrape] = useState<ScrapeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const responses = await Promise.all(
        ['/api/admin/sources', '/api/admin/guard-config', '/api/admin/prompt-config', '/api/admin/app-settings']
          .map((path) => adminFetch(path)),
      );
      if (responses.some((response) => !response.ok)) throw new Error('Could not load settings.');

      const [sources, guard, prompts, app] = await Promise.all(responses.map((r) => r.json()));
      setData({ sources, guard, prompts, app });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, [adminFetch]);

  useEffect(() => { void load(); }, [load]);

  const loadScrapeStatus = useCallback(async () => {
    try {
      const res = await adminFetch('/api/admin/scrape/status');
      if (res.ok) {
        const status = (await res.json()) as ScrapeStatus;
        setScrape(status);
        return status;
      }
    } catch {
      // The page still works without scraping status.
    }
    return null;
  }, [adminFetch]);

  useEffect(() => { void loadScrapeStatus(); }, [loadScrapeStatus]);

  /**
   * A run happens in the background because a full scrape can take minutes, so
   * the page polls until it finishes, then reloads the sources to pick up the
   * new cursor.
   */
  useEffect(() => {
    if (!scrape?.running) return;
    const timer = setInterval(() => {
      void (async () => {
        const status = await loadScrapeStatus();
        if (status && !status.running) await load();
      })();
    }, 1500);
    return () => clearInterval(timer);
  }, [scrape?.running, loadScrapeStatus, load]);

  const { notice, setNotice, run: save } = useAdminAction(load);

  const startScrape = useCallback(
    async (path: string, label: string) => {
      setNotice(null);
      try {
        const res = await adminFetch(path, { method: 'POST' });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setNotice(`⚠ ${body.error ?? 'Could not start the scrape.'}`);
          return;
        }
        setNotice(`${label} started. This page will update as it goes.`);
        await loadScrapeStatus();
      } catch {
        setNotice('⚠ Could not reach the server. Check it is running, then try again.');
      }
    },
    [adminFetch, loadScrapeStatus, setNotice],
  );

  if (loading) return <div className="container max-w-4xl py-10"><LoadingState label="Loading settings…" /></div>;
  if (error) return <div className="container max-w-4xl py-10"><ErrorState message={error} /></div>;
  if (!data) return null;

  return (
    <div className="container max-w-4xl py-10">
      <h1 className="font-display text-4xl mb-1">Settings</h1>
      <p className="text-muted-foreground mb-6">Sources, guardrails, prompts and app defaults.</p>

      {notice && <div className="mb-5"><Notice>{notice}</Notice></div>}

      <SourcesSection
        sources={data.sources}
        save={save}
        status={scrape}
        onRun={(sourceId) => void startScrape(`/api/admin/scrape/${sourceId}`, `Scrape of ${sourceId}`)}
        onRunAll={() => void startScrape('/api/admin/scrape', 'Scrape of all enabled sources')}
      />
      <GuardrailsSection guard={data.guard} save={save} />
      {/* Remount when the server's copy changes, so drafts start from fresh data. */}
      <PromptsSection key={JSON.stringify(data.prompts)} config={data.prompts} save={save} />
      <AppSettingsSection key={JSON.stringify(data.app)} settings={data.app} save={save} />
    </div>
  );
}
