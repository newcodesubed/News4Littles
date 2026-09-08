/**
 * What an editor sees when the server goes away mid-session.
 *
 * Before useAdminAction existed, a rejected fetch escaped into a floating
 * promise: the button did nothing, showed nothing, and logged nothing. These
 * tests exist so that cannot come back.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminReview } from '../pages/admin/AdminReview';
import { AdminSettings } from '../pages/admin/AdminSettings';

const ARTICLE = {
  id: 'a1', originalId: 'r1', ageTarget: 8, kidHeadline: 'A story', summary: 'S.',
  whatHappened: 'W.', whyItMatters: 'Y.', vocab: [], thinkAbout: 'T?', feelingNote: null,
  safety: 'calm', contentWarnings: null, category: 'World', readingMinutes: 3,
  sourceName: 'BBC News', sourceUrl: 'https://x', status: 'pending_review',
  rejectReason: null, editedByHuman: false, createdAt: '2026-09-04T10:00:00.000Z',
  publishedAt: null, sourceId: 'bbc', originalHeadline: 'Original',
};

const SOURCES = [{
  id: 'bbc', name: 'BBC News', url: 'https://feeds.example/rss', enabled: true,
  trustLevel: 'high', parser: 'rss', lastFetchedAt: null,
  lastFetchedItemPublishedAt: null, articleCount: 1,
}];

/** Serves the initial reads, then makes every later request reject. */
function serveThenGoOffline() {
  const loaded = new Set<string>();

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url);
    const body = (payload: unknown) =>
      ({ ok: true, status: 200, json: async () => payload, headers: new Headers() }) as unknown as Response;

    // Only the initial GETs succeed; every mutation hits the dead network.
    const isRead = (init.method ?? 'GET') === 'GET';

    if (isRead && !loaded.has(path)) {
      loaded.add(path);
      if (path.includes('/counts')) return body({ pending_review: 1, published: 0, rejected: 0, total: 1 });
      if (path.includes('/filters')) return body({ categories: ['World'], sources: [{ id: 'bbc', name: 'BBC News' }], ageTargets: [8] });
      if (path.includes('/scrape/status')) return body({ running: false, run: null, lastRuns: {} });
    if (path.includes('/sources')) return body(SOURCES);
      if (path.includes('/guard-config')) return body({ denyList: ['war'], denyListEnabled: true, promptGuardEnabled: false, promptGuardText: '' });
      if (path.includes('/prompt-config')) return body({ genericPrompt: 'p', ageOverrides: {}, versions: {}, inertUntilLlm: true });
      if (path.includes('/app-settings')) return body({ defaultAge: 6, scrapeTimes: ['06:00'], llmProvider: null, apiKeyLocation: 'env' });
      return body({ articles: [ARTICLE], total: 1 });
    }

    throw new TypeError('Failed to fetch');
  }));
}

const renderIn = (ui: React.ReactNode) =>
  render(<MemoryRouter><AdminAuthProvider>{ui}</AdminAuthProvider></MemoryRouter>);

beforeEach(() => {
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  serveThenGoOffline();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

const OFFLINE = /Could not reach the server/;

describe('review queue, server unreachable', () => {
  it('Publish reports the failure instead of doing nothing', async () => {
    renderIn(<AdminReview />);
    await screen.findByText('A story');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('Delete reports the failure', async () => {
    renderIn(<AdminReview />);
    await screen.findByText('A story');
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    // Delete now confirms in-app rather than through window.confirm.
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('Regenerate reports the failure', async () => {
    renderIn(<AdminReview />);
    await screen.findByText('A story');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('a bulk action reports the failure', async () => {
    renderIn(<AdminReview />);
    await screen.findByText('A story');
    await userEvent.click(screen.getByLabelText(/Select all/));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('the story stays on screen rather than vanishing', async () => {
    renderIn(<AdminReview />);
    await screen.findByText('A story');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText(OFFLINE);
    expect(screen.getByText('A story')).toBeInTheDocument();
  });
});

describe('settings, server unreachable', () => {
  it('toggling a source reports the failure', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    await userEvent.click(screen.getByLabelText('Enable BBC News'));
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('adding a deny-list word reports the failure', async () => {
    renderIn(<AdminSettings />);
    await screen.findByText('war');
    await userEvent.type(screen.getByLabelText('Add deny-list word'), 'volcano');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('saving app settings reports the failure', async () => {
    renderIn(<AdminSettings />);
    await screen.findByLabelText('Default reading age');
    await userEvent.click(screen.getByRole('button', { name: 'Save app settings' }));
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });
});

describe('a server error, as opposed to no server', () => {
  it('shows the message the API sent', async () => {
    let first = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url);
      const body = (payload: unknown, ok = true, status = 200) =>
        ({ ok, status, json: async () => payload, headers: new Headers() }) as unknown as Response;

      if (path.includes('/counts')) return body({ pending_review: 1, published: 0, rejected: 0, total: 1 });
      if (path.includes('/filters')) return body({ categories: [], sources: [], ageTargets: [] });
      if (path.includes('/api/admin/articles?') && first) { first = false; return body({ articles: [ARTICLE], total: 1 }); }
      if (path.includes('/api/admin/articles?')) return body({ articles: [ARTICLE], total: 1 });
      return body({ error: 'Published articles cannot be deleted.' }, false, 409);
    }));

    renderIn(<AdminReview />);
    await screen.findByText('A story');
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByText(/Published articles cannot be deleted/)).toBeInTheDocument();
  });
});

describe('a failed save must not leave the form lying', () => {
  it('reverts a source field to the stored value', async () => {
    renderIn(<AdminSettings />);
    const nameInput = await screen.findByDisplayValue('BBC News');

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed while offline');
    expect(nameInput).toHaveValue('Renamed while offline');

    // Blur commits; the PATCH fails because the server is gone.
    await userEvent.tab();

    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    // The box must show what the server actually holds, not the failed edit.
    expect(nameInput).toHaveValue('BBC News');
  });

  it('reverts the enabled toggle', async () => {
    renderIn(<AdminSettings />);
    const toggle = await screen.findByLabelText('Enable BBC News');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(toggle);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('reverts app settings', async () => {
    renderIn(<AdminSettings />);
    const age = await screen.findByLabelText('Default reading age');

    await userEvent.clear(age);
    await userEvent.type(age, '11');
    await userEvent.click(screen.getByRole('button', { name: 'Save app settings' }));

    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(age).toHaveValue(6);
  });
});
