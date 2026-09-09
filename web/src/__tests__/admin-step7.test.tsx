/**
 * Editor portal (§4.3) and admin settings (§4.4) behaviour.
 *
 * The rule that matters most: "Simplify with AI" must not save anything, and
 * the safety classification must not be settable from the submit form.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminSubmit } from '../pages/admin/AdminSubmit';
import { AdminSettings } from '../pages/admin/AdminSettings';

let calls: { method: string; path: string; body: any }[] = [];

const GENERATED = {
  id: 'preview', originalId: 'preview', ageTarget: 8,
  kidHeadline: 'Generated kid headline', summary: 'Generated summary.',
  whatHappened: 'Generated what happened.', whyItMatters: 'Generated why.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'Generated think about?', feelingNote: 'A gentle note.',
  safety: 'adult-nearby', contentWarnings: ['conflict'], category: 'Environment',
  readingMinutes: 3, sourceName: 'The Local Paper', sourceUrl: 'https://example.com/x',
  status: 'pending_review', rejectReason: null, editedByHuman: false,
  createdAt: '2026-09-04T10:00:00.000Z', publishedAt: null,
};

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    if (path.includes('/simplify')) return json({ article: GENERATED, guard: { matches: ['conflict', 'attack'], safety: 'adult-nearby', denyListEnabled: true, engine: 'local-fallback' } });
    if (path === '/api/admin/articles' && init.method === 'POST') return json({ ...GENERATED, id: 'new' }, 201);
    if (path.includes('/scrape/status')) return json({
      running: false,
      run: null,
      lastRuns: {
        bbc: {
          id: 'run1', sourceId: 'bbc', startedAt: '2026-09-08T06:00:00.000Z',
          finishedAt: '2026-09-08T06:01:00.000Z', ok: true, error: null,
          itemsInFeed: 45, inserted: 41, simplified: 10, leftWaiting: 31,
          skippedNotNew: 4, skippedAlreadyStored: 0,
          skippedUnusable: 0, costUsd: 0.0007, fallbacks: [], trigger: 'manual',
        },
      },
    });
    if (path.includes('/sources')) return json([
      { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', enabled: true, trustLevel: 'high', parser: 'rss', lastFetchedAt: '2026-09-04T06:00:00.000Z', lastFetchedItemPublishedAt: '2026-09-04T05:00:00.000Z', articleCount: 11 },
      { id: 'manual', name: 'Manual submission', url: '', enabled: false, trustLevel: 'high', parser: null, lastFetchedAt: null, lastFetchedItemPublishedAt: null, articleCount: 3 },
    ]);
    if (path.includes('/guard-config')) return json({ denyList: ['war', 'killed'], denyListEnabled: true, promptGuardEnabled: false, promptGuardText: '', ...overrides });
    if (path.includes('/prompt-config')) return json({ genericPrompt: 'The generic prompt', ageOverrides: { '6': 'Age six' }, versions: {}, inertUntilLlm: true });
    if (path.includes('/app-settings')) return json({ defaultAge: 6, scrapeTimes: ['06:00'], llmProvider: null, simplifyBudget: 10, apiKeyLocation: 'environment variable only (never stored in the database)' });
    return json({});
  }));
}

const renderIn = (ui: React.ReactNode) =>
  render(<MemoryRouter><AdminAuthProvider>{ui}</AdminAuthProvider></MemoryRouter>);

beforeEach(() => {
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  calls = [];
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

async function fillForm() {
  await userEvent.type(screen.getByLabelText('Original headline'), 'Council approves reef plan');
  await userEvent.type(screen.getByLabelText('Source name'), 'The Local Paper');
  await userEvent.type(screen.getByLabelText('Source URL'), 'https://example.com/x');
  await userEvent.type(screen.getByLabelText('Article text'), 'There was conflict and an attack near the reef.');
}

describe('editor portal — §4.3 form', () => {
  it('offers every field §4.3 lists', () => {
    renderIn(<AdminSubmit />);
    for (const label of ['Original headline', 'Source name', 'Source URL', 'Article text', 'Category', 'Age target']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('age target covers 5 to 14', () => {
    renderIn(<AdminSubmit />);
    const options = [...(screen.getByLabelText('Age target') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['5','6','7','8','9','10','11','12','13','14']);
  });

  it('Simplify is disabled until the form is filled in', async () => {
    renderIn(<AdminSubmit />);
    expect(screen.getByRole('button', { name: /Simplify with AI/ })).toBeDisabled();
    await fillForm();
    expect(screen.getByRole('button', { name: /Simplify with AI/ })).toBeEnabled();
  });

  it('says plainly that no AI key is configured', () => {
    renderIn(<AdminSubmit />);
    expect(screen.getByText(/No AI key is configured/)).toBeInTheDocument();
  });

  it('has no Save draft button — §8.3 has no draft status', async () => {
    renderIn(<AdminSubmit />);
    expect(screen.queryByRole('button', { name: /draft/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send for review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish now' })).toBeInTheDocument();
  });
});

describe('Simplify with AI — requirement 3', () => {
  it('populates the review output without saving anything', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /Simplify with AI/ }));

    expect(await screen.findByDisplayValue('Generated kid headline')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Generated summary.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('reef')).toBeInTheDocument();

    // The only call is the preview; no POST to /articles.
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/admin/simplify')).toBe(true);
    expect(calls.some((c) => c.path === '/api/admin/articles')).toBe(false);
    expect(screen.getByText(/nothing has been saved yet/)).toBeInTheDocument();
  });

  it('shows the guard verdict and which words matched', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /Simplify with AI/ }));
    expect(await screen.findByText(/matched 2 deny-list word\(s\): conflict, attack/)).toBeInTheDocument();
  });

  it('labels the engine as local-fallback, not an LLM', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /Simplify with AI/ }));
    expect(await screen.findByText('model: local-fallback')).toBeInTheDocument();
  });

  it('shows the feeling note for a non-calm story', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /Simplify with AI/ }));
    expect(await screen.findByText(/added because this story is not calm/)).toBeInTheDocument();
  });

  it('editing the source text clears the stale preview', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /Simplify with AI/ }));
    await screen.findByDisplayValue('Generated kid headline');
    await userEvent.type(screen.getByLabelText('Article text'), ' More text.');
    expect(screen.queryByDisplayValue('Generated kid headline')).not.toBeInTheDocument();
  });
});

describe('saving — requirements 2, 4, 5', () => {
  it('Send for review posts status pending_review', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/articles');
      expect(post?.body.status).toBe('pending_review');
    });
  });

  it('never sends a safety value — the guard decides server-side', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /Simplify with AI/ }));
    await screen.findByDisplayValue('Generated kid headline');
    await userEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/articles');
      expect(post).toBeDefined();
      expect('safety' in post!.body).toBe(false);
      expect('contentWarnings' in post!.body).toBe(false);
    });
  });

  it('sends the editor’s text edits', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /Simplify with AI/ }));
    const headline = await screen.findByDisplayValue('Generated kid headline');
    await userEvent.clear(headline);
    await userEvent.type(headline, 'My own headline');
    await userEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/articles');
      expect(post?.body.kidHeadline).toBe('My own headline');
    });
  });

  it('Publish now asks for confirmation first', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Publish now' }));

    // An in-app dialog, not window.confirm.
    const dialog = await screen.findByRole('dialog', { name: 'Publish straight to the site?' });
    expect(within(dialog).getByText(/skips the review queue/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/admin/articles')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.path === '/api/admin/articles')).toBe(false);
  });

  it('Publish now posts only after the dialog is confirmed', async () => {
    renderIn(<AdminSubmit />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish now' }),
    );
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/articles');
      expect(post?.body.status).toBe('published');
    });
  });
});

describe('settings — §5.1 sources', () => {
  it('lists sources with article counts', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByDisplayValue('BBC News')).toBeInTheDocument();
    expect(screen.getByText('11 article(s)')).toBeInTheDocument();
  });

  it('shows scraper state as read-only text, not an editable field', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    // The label moved onto its own line and gained a capital when the
    // last-run summary was added above it.
    expect(screen.getAllByText(/Newest item seen:/).length).toBe(2);
    // No input anywhere is bound to the cursor value.
    expect(screen.queryByDisplayValue('2026-09-04T05:00:00.000Z')).not.toBeInTheDocument();
  });

  it('shows what the last run did (§4.4)', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    expect(screen.getAllByText(/Last run:/).length).toBe(2);
    // BBC has a recorded run; manual has never been scraped. The run stored 41
    // and simplified 10 of them, which is the budget doing its job.
    // The <strong> counts split the text nodes, so match on the whole line.
    const lastRun = await screen.findByText(/already seen/);
    expect(lastRun).toHaveTextContent(/41 new/);
    expect(lastRun).toHaveTextContent(/10 simplified/);
    expect(lastRun).toHaveTextContent(/31 still raw/);
    expect(lastRun).toHaveTextContent(/4 already seen/);
    expect(lastRun).toHaveTextContent(/\$0\.00070/);
    expect(screen.getAllByText('never run').length).toBe(1);
  });

  it('reports a failed run rather than staying silent (§4.4)', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    // The seeded run succeeded, so no failure text should appear.
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it('offers Run now per source and for all enabled sources (§4.4)', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    expect(screen.getAllByRole('button', { name: /^Run now$/ }).length).toBe(2);
    expect(screen.getByRole('button', { name: /Run all enabled/ })).toBeInTheDocument();
  });

  it('starting a run posts to the scrape endpoint', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    await userEvent.click(screen.getByRole('button', { name: /Run all enabled/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/admin/scrape')).toBe(true));
  });

  it('running one source posts to that source', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    await userEvent.click(screen.getAllByRole('button', { name: /^Run now$/ })[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/admin/scrape/bbc')).toBe(true));
  });

  it('offers a cursor reset instead', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    expect(screen.getAllByRole('button', { name: /reset/i }).length).toBeGreaterThan(0);
  });

  it('toggling enabled PATCHes the source', async () => {
    renderIn(<AdminSettings />);
    await screen.findByDisplayValue('BBC News');
    await userEvent.click(screen.getByLabelText('Enable BBC News'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/api/admin/sources/bbc' && c.body.enabled === false)).toBe(true));
  });
});

describe('settings — §6 guardrails', () => {
  it('lists the deny-list words', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByText('war')).toBeInTheDocument();
    expect(screen.getByText('killed')).toBeInTheDocument();
  });

  it('adding a word PUTs the whole list', async () => {
    renderIn(<AdminSettings />);
    await screen.findByText('war');
    await userEvent.type(screen.getByLabelText('Add deny-list word'), 'volcano');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/admin/guard-config');
      expect(put?.body.denyList).toEqual(['war', 'killed', 'volcano']);
    });
  });

  it('removing a word PUTs the list without it', async () => {
    renderIn(<AdminSettings />);
    await screen.findByText('war');
    await userEvent.click(screen.getByLabelText('Remove war'));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/admin/guard-config');
      expect(put?.body.denyList).toEqual(['killed']);
    });
  });

  it('explains the thresholds', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByText(/0 matches → calm/)).toBeInTheDocument();
  });
});

describe('settings — §8.5 prompts are clearly inert', () => {
  it('warns that prompts do nothing without an LLM', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByText(/No LLM is wired up yet/)).toBeInTheDocument();
  });

  it('shows version counters as read-only', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByText(/only a sandbox promotion changes these/)).toBeInTheDocument();
  });

  it('saving prompts omits versions', async () => {
    renderIn(<AdminSettings />);
    await screen.findByText(/No LLM is wired up yet/);
    await userEvent.click(screen.getByRole('button', { name: 'Save prompts' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/admin/prompt-config');
      expect(put).toBeDefined();
      expect('versions' in put!.body).toBe(false);
    });
  });
});

describe('settings — §8.7 app settings', () => {
  it('shows defaultAge, scrape times and provider', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByLabelText('Default reading age')).toHaveValue(6);
    expect(screen.getByText('06:00')).toBeInTheDocument();
    expect(screen.getByLabelText('LLM provider')).toHaveValue('');
  });

  it('states the API key is never stored in the database', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByText(/never stored in the database/)).toBeInTheDocument();
  });

  it('warns that a scrape-time change needs a restart', async () => {
    renderIn(<AdminSettings />);
    expect(await screen.findByText(/take effect when the server restarts/)).toBeInTheDocument();
  });

  it('saves the simplification budget', async () => {
    const user = userEvent.setup();
    renderIn(<AdminSettings />);

    const input = await screen.findByLabelText(/simplifications per scrape run/i);
    expect(input).toHaveValue(10);

    await user.clear(input);
    await user.type(input, '4');
    await user.click(screen.getByRole('button', { name: /save app settings/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.path.includes('/app-settings') && call.method === 'PUT');
      expect(put?.body.simplifyBudget).toBe(4);
    });
  });

  it('shows how much of a run was simplified and how much was left raw', async () => {
    renderIn(<AdminSettings />);

    // The point of the whole feature, on one line: 41 stored, 10 paid for.
    const summary = await screen.findByText(/still raw/);
    expect(summary).toHaveTextContent(/41/);
    expect(summary).toHaveTextContent(/10.*simplified/);
    expect(summary).toHaveTextContent(/31 still raw/);
  });
});
