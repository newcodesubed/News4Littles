/**
 * Review-queue usability: reading a story before judging it, feedback while an
 * action runs, and confirmations that belong to the product rather than the
 * browser.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminReview } from '../pages/admin/AdminReview';

const ARTICLE = {
  id: 'a1', originalId: 'r1', ageTarget: 8,
  kidHeadline: 'A secret coral garden was found',
  summary: 'Scientists found a coral garden.',
  whatHappened: 'A robot went down with bright lights.',
  whyItMatters: 'Lots of sea animals live in coral.',
  vocab: [{ word: 'reef', definition: 'A ridge of rock under the sea.' }],
  thinkAbout: 'Where would you send a robot?',
  feelingNote: null, safety: 'calm', contentWarnings: null, category: 'Environment',
  readingMinutes: 3, sourceName: 'BBC News', sourceUrl: 'https://example.com/original',
  status: 'pending_review', rejectReason: null, editedByHuman: false,
  createdAt: '2026-09-08T10:00:00.000Z', publishedAt: null,
  sourceId: 'bbc', originalHeadline: 'Survey team documents uncharted reef',
};

let calls: { method: string; path: string }[] = [];
let articles: any[] = [];
/** Resolves the next mutation, so a request can be observed in flight. */
let releaseMutation: (() => void) | null = null;

function mockApi({ slowMutations = false } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method ?? 'GET';
    calls.push({ method, path });
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    if (path.includes('/counts')) return json({ pending_review: 1, published: 0, rejected: 0, total: 1 });
    if (path.includes('/filters')) return json({ categories: ['Environment'], sources: [{ id: 'bbc', name: 'BBC News' }], ageTargets: [8] });
    // §5: the queue reads stories. One story per fixture article, since these
    // fixtures each have their own originalId.
    if (path.includes('/stories')) {
      return json({
        stories: articles.map((a) => ({
          originalId: a.originalId,
          versions: [a],
          safety: a.safety,
          status: a.status,
          approvedBy: (a as { approvedBy?: string | null }).approvedBy ?? null,
          kidHeadline: a.kidHeadline,
          category: a.category,
          sourceId: a.sourceId,
          originalHeadline: a.originalHeadline,
          createdAt: a.createdAt,
        })),
        total: articles.length,
      });
    }
    if (method === 'GET') return json({ articles, total: articles.length });

    if (slowMutations) {
      await new Promise<void>((resolve) => { releaseMutation = resolve; });
    }
    if (path.includes('/regenerate')) {
      return json({ current: articles[0], generated: { ...articles[0], kidHeadline: 'Regenerated' } });
    }
    return json(articles[0]);
  }));
}

const renderQueue = () =>
  render(<MemoryRouter><AdminAuthProvider><AdminReview /></AdminAuthProvider></MemoryRouter>);

beforeEach(() => {
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  calls = [];
  articles = [ARTICLE];
  releaseMutation = null;
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('reading a story before judging it', () => {
  it('offers a View action on every row', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    expect(screen.getByRole('button', { name: /View/ })).toBeInTheDocument();
  });

  it('shows the whole story, the way a reader sees it', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /View/ }));

    const dialog = await screen.findByRole('dialog');
    // Every section of the public story page, not just the summary.
    expect(within(dialog).getByText('What happened?')).toBeInTheDocument();
    expect(within(dialog).getByText(ARTICLE.whatHappened)).toBeInTheDocument();
    expect(within(dialog).getByText('Why it matters')).toBeInTheDocument();
    expect(within(dialog).getByText('Words to know')).toBeInTheDocument();
    expect(within(dialog).getByText('reef')).toBeInTheDocument();
    expect(within(dialog).getByText('Something to think about')).toBeInTheDocument();
  });

  it('opens from the headline too', async () => {
    renderQueue();
    await userEvent.click(await screen.findByRole('button', { name: ARTICLE.kidHeadline }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows the editor context a reader would not see', async () => {
    articles = [{ ...ARTICLE, status: 'rejected', rejectReason: 'Too grim', editedByHuman: true }];
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /View/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Rejected earlier: Too grim/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Survey team documents uncharted reef/)).toBeInTheDocument();
  });

  it('never shows a feeling note on a calm story, as on the public page', async () => {
    articles = [{ ...ARTICLE, safety: 'calm', feelingNote: 'This should never appear.' }];
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /View/ }));
    expect(screen.queryByText('This should never appear.')).not.toBeInTheDocument();
  });

  it('hands off to Edit without losing the story', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /View/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Edit' }));

    expect(await screen.findByDisplayValue(ARTICLE.kidHeadline)).toBeInTheDocument();
  });

  it('can publish straight from the preview', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /View/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(calls.some((c) => c.path.includes('/publish'))).toBe(true));
  });

  it('offers no Publish for an already published story', async () => {
    articles = [{ ...ARTICLE, status: 'published', publishedAt: '2026-09-08T11:00:00.000Z' }];
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /View/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });
});

describe('feedback while an action runs', () => {
  beforeEach(() => { calls = []; mockApi({ slowMutations: true }); });

  it('Regenerate says it is working and cannot be clicked twice', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));

    const button = await screen.findByRole('button', { name: /Regenerating/ });
    expect(button).toBeDisabled();

    // A second click while it works must not fire another request.
    const before = calls.filter((c) => c.path.includes('/regenerate')).length;
    await userEvent.click(button);
    expect(calls.filter((c) => c.path.includes('/regenerate')).length).toBe(before);

    releaseMutation?.();
  });

  it('locks the other actions on that row while one runs', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await screen.findByRole('button', { name: /Regenerating/ });

    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeDisabled();

    releaseMutation?.();
  });

  it('re-enables everything once the action finishes', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(releaseMutation).not.toBeNull());

    releaseMutation?.();
    await waitFor(() => expect(screen.getByRole('button', { name: /Regenerate/ })).toBeEnabled());
  });
});

describe('confirmations that belong to the product', () => {
  it('Delete asks in-app, naming the story', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete this story?' });
    expect(within(dialog).getByText(ARTICLE.kidHeadline)).toBeInTheDocument();
    // It should say what survives, not just warn.
    expect(within(dialog).getByText(/original article stays/)).toBeInTheDocument();
  });

  it('Cancel deletes nothing', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Confirm deletes', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('bulk delete says how many, and skips nothing silently', async () => {
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByLabelText(/Select all/));

    // Both the bulk bar and the row have a Delete button; scope to the bar.
    const bar = screen.getByText('1 selected').closest('div')!;
    await userEvent.click(within(bar).getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 article?' });
    expect(within(dialog).getByText(/Published articles in the selection are skipped/)).toBeInTheDocument();
  });

  it('uses no browser dialog at all', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderQueue();
    await screen.findByText(ARTICLE.kidHeadline);
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await screen.findByRole('dialog');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
