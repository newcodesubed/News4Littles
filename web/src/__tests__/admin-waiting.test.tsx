/**
 * The review queue's "Not yet simplified" tab.
 *
 * These raw rows are the articles a scrape stored but did not spend its budget
 * on, so the safety-relevant point is what they are NOT: they carry no kid
 * headline, no safety verdict, and cannot be approved from here.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminReview } from '../pages/admin/AdminReview';
import type { WaitingRawArticle } from '../admin/types';

const RAW: WaitingRawArticle = {
  id: 'r1', sourceId: 'bbc', sourceName: 'BBC News',
  headline: 'Adult headline about the reef', url: 'https://example.com/1',
  topic: 'World', publishedAt: '2026-09-08T10:00:00.000Z',
  fetchedAt: '2026-09-08T11:00:00.000Z', bodyLength: 1400,
};
const raw = (over: Partial<WaitingRawArticle> = {}): WaitingRawArticle => ({ ...RAW, ...over });

let waiting: WaitingRawArticle[] = [];
let simplifyBody: { ids: string[] } | null = null;
let dismissBody: { ids: string[] } | null = null;
let jobRunning = false;

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url);
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    const job = (running: boolean) => ({
      id: 'j1', startedAt: '2026-09-09T10:00:00.000Z', rawIds: simplifyBody?.ids ?? [],
      done: running ? 1 : (simplifyBody?.ids ?? []).length, running,
      report: {
        simplified: running
          ? []
          : (simplifyBody?.ids ?? []).map((rawId) => ({ rawId, kidHeadline: 'A kid headline' })),
        failures: [], skipped: [],
      },
    });

    if (path.includes('/raw-articles/simplify/status')) {
      return json({ running: jobRunning, job: job(jobRunning) });
    }
    if (path.includes('/raw-articles/simplify')) {
      simplifyBody = JSON.parse(String(init.body));
      jobRunning = true;
      return json({ running: true, job: job(true) }, 202);
    }
    if (path.includes('/raw-articles/dismiss')) {
      dismissBody = JSON.parse(String(init.body));
      const ids = dismissBody!.ids;
      waiting = waiting.filter((row) => !ids.includes(row.id));
      return json({ dismissed: ids.length });
    }
    if (path.includes('/raw-articles/waiting')) {
      return json({ articles: waiting, total: waiting.length });
    }
    if (path.includes('/articles/counts')) {
      return json({ pending_review: 2, published: 0, rejected: 0, total: 2, waiting: waiting.length });
    }
    if (path.includes('/articles/filters')) {
      return json({
        categories: [], sources: [{ id: 'bbc', name: 'BBC News' }],
        ageTargets: [], safety: [], statuses: [], sortFields: [],
      });
    }
    if (path.includes('/stories')) return json({ stories: [], total: 0 });
    if (path.includes('/articles')) return json({ articles: [], total: 0 });
    return json({});
  }));
}

const view = () =>
  render(
    <MemoryRouter>
      <AdminAuthProvider>
        <AdminReview />
      </AdminAuthProvider>
    </MemoryRouter>,
  );

/** Switches to the backlog tab and waits for its first load. */
async function openTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /not yet simplified/i }));
  await waitFor(() => expect(screen.getByText(RAW.headline)).toBeInTheDocument());
}

beforeEach(() => {
  waiting = [raw()];
  simplifyBody = null;
  dismissBody = null;
  jobRunning = false;
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('the waiting tab', () => {
  it('shows a count badge from the counts endpoint', async () => {
    waiting = [raw(), raw({ id: 'r2' })];
    view();

    const tab = await screen.findByRole('button', { name: /not yet simplified/i });
    await waitFor(() => expect(within(tab).getByText('2')).toBeInTheDocument());
  });

  it('lists the original adult headline and its source', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    // Scoped to the row's meta line: "BBC News" is also a source dropdown option.
    expect(screen.getByText(/BBC News · World/)).toBeInTheDocument();
    // A raw article has no kid headline and no safety badge yet.
    expect(screen.queryByText(/A kid headline/)).not.toBeInTheDocument();
  });

  it('warns when a stored item is too short to be a real story', async () => {
    waiting = [raw({ bodyLength: 40 })];
    const user = userEvent.setup();
    view();
    await openTab(user);

    expect(screen.getByText(/may be a stub/i)).toBeInTheDocument();
  });

  it('posts the selected id when one row is simplified', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByRole('button', { name: /^simplify$/i }));

    await waitFor(() => expect(simplifyBody).toEqual({ ids: ['r1'] }));
  });

  it('posts every selected id for a bulk simplify', async () => {
    waiting = [raw(), raw({ id: 'r2', headline: 'Second adult headline' })];
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByLabelText(/select all/i));
    await user.click(screen.getByRole('button', { name: /simplify 2 selected/i }));

    await waitFor(() => expect(simplifyBody).toEqual({ ids: ['r1', 'r2'] }));
  });

  it('shows progress while the job runs, then reports the result', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByRole('button', { name: /^simplify$/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/simplifying/i));

    // The job finishes and the panel reloads: the row leaves the backlog.
    jobRunning = false;
    waiting = [];
    await waitFor(
      () => expect(screen.getByText(/1 article\(s\) simplified/i)).toBeInTheDocument(),
      { timeout: 6000 },
    );
  });

  it('deletes one row after confirming, then reloads the backlog and the badge', async () => {
    waiting = [raw(), raw({ id: 'r2', headline: 'Second adult headline' })];
    const user = userEvent.setup();
    view();
    await openTab(user);

    const row = screen.getByText(RAW.headline).closest('div.rounded-2xl') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/won't bring it back/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(dismissBody).toEqual({ ids: ['r1'] }));
    await waitFor(() => expect(screen.queryByText(RAW.headline)).not.toBeInTheDocument());
    expect(screen.getByText(/1 article\(s\) deleted/i)).toBeInTheDocument();
    const tab = screen.getByRole('button', { name: /not yet simplified/i });
    await waitFor(() => expect(within(tab).getByText('1')).toBeInTheDocument());
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }));

    expect(dismissBody).toBeNull();
    expect(screen.getByText(RAW.headline)).toBeInTheDocument();
  });

  it('posts every selected id for a bulk delete', async () => {
    waiting = [raw(), raw({ id: 'r2', headline: 'Second adult headline' })];
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByLabelText(/select all/i));
    await user.click(screen.getByRole('button', { name: /delete 2 selected/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/delete 2 articles\?/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^delete 2$/i }));

    await waitFor(() => expect(dismissBody).toEqual({ ids: ['r1', 'r2'] }));
  });

  it('cannot delete while a simplify job is running', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);

    await user.click(screen.getByRole('button', { name: /^simplify$/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/simplifying/i));

    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete 0 selected/i })).toBeDisabled();
  });

  it('picks up a batch that was already running when the tab opened', async () => {
    // Started earlier, then the editor left the tab and came back.
    simplifyBody = { ids: ['r1'] };
    jobRunning = true;
    const user = userEvent.setup();
    view();
    await openTab(user);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/simplifying/i));
    expect(screen.getByRole('button', { name: /^simplify$/i })).toBeDisabled();
  });

  it('links to Pending review once a batch finishes', async () => {
    const user = userEvent.setup();
    view();
    await openTab(user);
    await user.click(screen.getByRole('button', { name: /^simplify$/i }));
    jobRunning = false;
    waiting = [];

    const link = await screen.findByRole('link', { name: /open pending review/i }, { timeout: 4000 });
    await user.click(link);

    expect(screen.getByRole('button', { name: /^Pending review/ })).toHaveAttribute('aria-current', 'page');
  });

  it('never sends status=waiting to the article query', async () => {
    // 'waiting' is not a kid_articles status; the API rejects it with a 400.
    const user = userEvent.setup();
    view();
    await openTab(user);

    const requested = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(requested.some((url) => url.includes('status=waiting'))).toBe(false);
  });
});
