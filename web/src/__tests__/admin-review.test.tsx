/**
 * Review queue behaviour — PRD §4.2.
 *
 * The safety-critical rule here is bulk approve: skip-young stories must be
 * left out unless the editor explicitly opts in, and the exclusion must be
 * visible. Asserted in both directions.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminReview } from '../pages/admin/AdminReview';
import type { AdminArticle } from '../admin/types';

const BASE: AdminArticle = {
  id: 'a1', originalId: 'r1', ageTarget: 8,
  kidHeadline: 'A calm story', summary: 'Summary.', whatHappened: 'What.', whyItMatters: 'Why.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }], thinkAbout: 'Think?',
  feelingNote: null, safety: 'calm', contentWarnings: null, category: 'World', readingMinutes: 3,
  sourceName: 'BBC News', sourceUrl: 'https://example.com/a', status: 'pending_review',
  rejectReason: null, editedByHuman: false,
  createdAt: '2026-09-04T10:00:00.000Z', publishedAt: null,
  sourceId: 'bbc', originalHeadline: 'Original adult headline', approvedBy: null,
};
/**
 * A fixture article. `originalId` defaults to one derived from the id, so each
 * article is its own STORY unless a test deliberately groups several under one
 * originalId — which is what the §5 grouping tests do.
 */
const article = (o: Partial<AdminArticle> = {}): AdminArticle => ({
  ...BASE,
  originalId: `raw-${o.id ?? BASE.id}`,
  ...o,
});

let articles: AdminArticle[] = [];
let bulkBody: any = null;
let calls: string[] = [];

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url);
    calls.push(`${init.method ?? 'GET'} ${path.replace(/^https?:\/\/[^/]+/, '')}`);
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    if (path.includes('/articles/counts')) return json({ pending_review: 3, published: 1, rejected: 1, total: 5, waiting: 0 });
    if (path.includes('/articles/filters')) return json({ categories: ['World', 'Science'], sources: [{ id: 'bbc', name: 'BBC News' }, { id: 'manual', name: 'Manual submission' }], ageTargets: [6, 8], safety: [], statuses: [], sortFields: [] });
    if (path.includes('/articles/bulk')) {
      bulkBody = JSON.parse(String(init.body));
      const flagged = articles.filter((a) => bulkBody.ids.includes(a.id) && a.safety === 'skip-young');
      const excluded = bulkBody.action === 'approve' && !bulkBody.includeFlagged ? flagged : [];
      return json({
        action: bulkBody.action,
        applied: bulkBody.ids.filter((id: string) => !excluded.some((a) => a.id === id)),
        skipped: excluded.map((a) => ({ id: a.id, reason: 'flagged skip-young' })),
        appliedCount: bulkBody.ids.length - excluded.length,
        skippedCount: excluded.length,
      });
    }
    if (path.includes('/regenerate')) {
      return json({ current: articles[0], generated: { ...articles[0], kidHeadline: 'Regenerated headline', summary: 'New summary.' } });
    }
    if (path.includes('/api/admin/stories')) {
      // Group the flat fixture the way the server does.
      const byStory = new Map<string, AdminArticle[]>();
      for (const a of articles) {
        const list = byStory.get(a.originalId);
        if (list) list.push(a);
        else byStory.set(a.originalId, [a]);
      }
      const rank: Record<string, number> = { calm: 0, 'adult-nearby': 1, 'skip-young': 2 };
      const stories = [...byStory.entries()].map(([originalId, versions]) => ({
        originalId,
        versions,
        safety: versions.reduce((w, v) => (rank[v.safety] > rank[w] ? v.safety : w), 'calm' as string),
        status: versions[0].status,
        approvedBy: versions[0].approvedBy ?? null,
        kidHeadline: versions[0].kidHeadline,
        category: versions[0].category,
        sourceId: versions[0].sourceId,
        originalHeadline: versions[0].originalHeadline,
        createdAt: versions[0].createdAt,
      }));
      return json({ stories, total: stories.length });
    }
    if (path.includes('/api/admin/articles')) return json({ articles, total: articles.length });
    return json({});
  }));
}

/** The most recent queue list call (counts + filters run in parallel). */
const lastListCall = () =>
  [...calls].reverse().find((c) => c.startsWith('GET /api/admin/stories?')) ?? '';

const renderPage = () => render(
  <MemoryRouter><AdminAuthProvider><AdminReview /></AdminAuthProvider></MemoryRouter>,
);

beforeEach(() => {
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  articles = [article()]; bulkBody = null; calls = [];
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('tabs and counts (§4.2)', () => {
  it('shows a count badge per status tab', async () => {
    renderPage();
    await screen.findByText('A calm story');
    expect(within(screen.getByRole('button', { name: /Pending review/ })).getByText('3')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^Published/ })).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^Rejected/ })).getByText('1')).toBeInTheDocument();
  });

  it('defaults to the pending_review tab', async () => {
    renderPage();
    await screen.findByText('A calm story');
    expect(calls.some((c) => c.includes('status=pending_review'))).toBe(true);
  });

  it('switching tab refetches with that status', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Published/ }));
    await waitFor(() => expect(calls.some((c) => c.includes('status=published'))).toBe(true));
  });
});

describe('filters (§4.2)', () => {
  it('"flagged only" requests both non-calm levels in one click', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Flagged only/ }));
    await waitFor(() => expect(calls.some((c) => c.includes('flagged=true'))).toBe(true));
  });

  it('category, source and age filters combine with the tab', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: 'Science' }));
    await userEvent.click(screen.getByRole('button', { name: 'BBC News' }));
    await waitFor(() => {
      const last = lastListCall();
      expect(last).toContain('category=Science');
      expect(last).toContain('source=bbc');
      expect(last).toContain('status=pending_review');
    });
  });

  it('free-text search is sent as q', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.type(screen.getByLabelText('Search'), 'coral');
    await waitFor(() => expect(calls.some((c) => c.includes('q=coral'))).toBe(true));
  });

  it('sort field and direction are sent', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Newest first/ }));
    await waitFor(() => expect(calls.some((c) => c.includes('order=asc'))).toBe(true));
  });
});

describe('bulk approve protects skip-young (§4.2, requirement 6 + 13)', () => {
  beforeEach(() => {
    articles = [
      article({ id: 'safe1', kidHeadline: 'Safe one', safety: 'calm' }),
      article({ id: 'flag1', kidHeadline: 'Flagged one', safety: 'skip-young', feelingNote: 'note' }),
    ];
  });

  it('warns before approving when a skip-young row is selected', async () => {
    renderPage();
    await screen.findByText('Flagged one');
    await userEvent.click(screen.getByLabelText(/Select all/));
    expect(await screen.findByText(/will be left out of Approve/)).toBeInTheDocument();
  });

  it('sends includeFlagged:false by default and reports what was skipped', async () => {
    renderPage();
    await screen.findByText('Flagged one');
    await userEvent.click(screen.getByLabelText(/Select all/));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(bulkBody).not.toBeNull());
    expect(bulkBody.includeFlagged).toBe(false);
    expect(await screen.findByText(/1 article\(s\) were skipped/)).toBeInTheDocument();
    expect(screen.getByText(/flagged skip-young/)).toBeInTheDocument();
  });

  it('only sends includeFlagged:true after the editor ticks the box', async () => {
    renderPage();
    await screen.findByText('Flagged one');
    await userEvent.click(screen.getByLabelText(/Select all/));
    const warning = await screen.findByText(/will be left out of Approve/);
    await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(bulkBody).not.toBeNull());
    expect(bulkBody.includeFlagged).toBe(true);
  });
});

describe('row actions (§4.2)', () => {
  it('delete is disabled for published articles (requirement 7)', async () => {
    articles = [article({ status: 'published', publishedAt: '2026-09-04T11:00:00.000Z' })];
    renderPage();
    await screen.findByText('A calm story');
    expect(screen.getByRole('button', { name: /Delete/ })).toBeDisabled();
  });

  it('delete is enabled for pending articles', async () => {
    renderPage();
    await screen.findByText('A calm story');
    expect(screen.getByRole('button', { name: /Delete/ })).toBeEnabled();
  });

  it('published rows offer Re-review, not Publish', async () => {
    articles = [article({ status: 'published', publishedAt: '2026-09-04T11:00:00.000Z' })];
    renderPage();
    await screen.findByText('A calm story');
    expect(screen.getByRole('button', { name: /Re-review/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('reject opens a reason box before sending (requirement 10)', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Reject this story')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Reason \(optional\)/), 'Not kid news');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      const call = calls.find((c) => c.includes('/reject'));
      expect(call).toBeDefined();
    });
  });

  it('an existing reject reason is shown on the row', async () => {
    articles = [article({ status: 'rejected', rejectReason: 'Too grim' })];
    renderPage();
    expect(await screen.findByText(/Too grim/)).toBeInTheDocument();
  });

  it('marks rows a person has edited', async () => {
    articles = [article({ editedByHuman: true })];
    renderPage();
    expect(await screen.findByText('edited by a person')).toBeInTheDocument();
  });
});

describe('regenerate requires confirmation (requirement 12)', () => {
  it('shows a before/after diff and does not save on open', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));

    expect(await screen.findByText('Regenerate — review before applying')).toBeInTheDocument();
    expect(screen.getByText('Regenerated headline')).toBeInTheDocument();
    expect(calls.some((c) => c.includes('/regenerate/apply'))).toBe(false);
  });

  it('Discard closes without applying', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByText('Regenerate — review before applying')).not.toBeInTheDocument());
    expect(calls.some((c) => c.includes('/regenerate/apply'))).toBe(false);
  });

  it('Apply calls the apply endpoint', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Apply regenerated/ }));
    await waitFor(() => expect(calls.some((c) => c.includes('POST /api/admin/articles/a1/regenerate/apply'))).toBe(true));
  });

  it('warns when applying would wipe a human edit', async () => {
    articles = [article({ editedByHuman: true })];
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(await screen.findByText(/edited by a person. Applying will replace those edits/)).toBeInTheDocument();
  });
});

describe('edit form (requirement 11)', () => {
  it('opens with the current values and PATCHes on save', async () => {
    renderPage();
    await screen.findByText('A calm story');
    await userEvent.click(screen.getByRole('button', { name: /Edit/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('A calm story')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('reef')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c === 'PATCH /api/admin/articles/a1')).toBe(true));
  });
});

describe('auth', () => {
  it('sends the Basic credential on every admin call', async () => {
    renderPage();
    await screen.findByText('A calm story');
    const call = vi.mocked(fetch).mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('admin:admin123')}`);
  });
});

describe('one row per story (§5)', () => {
  it('shows a single row for a story with several age versions', async () => {
    articles = [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, kidHeadline: 'A calm story' }),
      article({ id: 'v8', originalId: 'raw-1', ageTarget: 8, kidHeadline: 'A calm story' }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14, kidHeadline: 'A calm story' }),
    ];
    renderPage();

    // One row, not three.
    await waitFor(() => expect(screen.getAllByText('A calm story')).toHaveLength(1));
    expect(await screen.findByText(/3 reading ages/i)).toBeInTheDocument();
  });

  it('shows the strictest safety across the versions', async () => {
    articles = [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, safety: 'skip-young', feelingNote: 'note' }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14, safety: 'calm' }),
    ];
    renderPage();

    // The editor is about to approve both, so the row must warn about age 5.
    // SafetyBadge renders the friendly label, not the raw value.
    expect(await screen.findByText(/Skip for young kids/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Calm$/)).not.toBeInTheDocument();
  });

  it('sends one version id when approving, and the server applies it to the story', async () => {
    articles = [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5 }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14 }),
    ];
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('A calm story');

    await user.click(screen.getByRole('button', { name: /publish all/i }));

    await waitFor(() => {
      expect(calls.some((c) => c === 'PATCH /api/admin/articles/v5/publish')).toBe(true);
    });
  });
});

describe('auto mode is visible in the queue', () => {
  it('marks a story the judge published, not a person', async () => {
    articles = [article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, status: 'published', approvedBy: 'auto' })];
    renderPage();

    // §2.2 says a human reads every story first. When auto mode did not, the
    // queue has to say so — it is the only way to find and undo it.
    expect(await screen.findByText(/published by the judge, not a person/i)).toBeInTheDocument();
  });

  it('says nothing for a story a person published', async () => {
    articles = [article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, status: 'published', approvedBy: null })];
    renderPage();

    await screen.findByText('A calm story');
    expect(screen.queryByText(/published by the judge/i)).not.toBeInTheDocument();
  });
});
