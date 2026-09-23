/** The admin chrome and review queue below the md breakpoint. */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminChrome } from '../pages/admin/AdminLayout';
import { FilterBar } from '../pages/admin/review/FilterBar';
import { StoryRow } from '../pages/admin/review/StoryRow';
import { EMPTY_FILTERS, type AdminStory } from '../admin/types';

const STORAGE_KEY = 'news4littles.admin';

const renderChrome = (initial = '/admin/review') =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <AdminAuthProvider>
        <Routes>
          <Route path="/admin" element={<AdminChrome />}>
            <Route path="review" element={<p>review page</p>} />
            <Route path="submit" element={<p>submit page</p>} />
          </Route>
        </Routes>
      </AdminAuthProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  window.sessionStorage.setItem(STORAGE_KEY, btoa('admin:admin123'));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response));
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('admin header', () => {
  it('keeps the logo on one line', () => {
    renderChrome();
    expect(screen.getByText('Editor', { exact: false }).closest('span')).toHaveClass('whitespace-nowrap');
  });

  it('hides the nav and the right-side links below md', () => {
    renderChrome();
    expect(screen.getByRole('link', { name: 'Review' }).closest('nav')).toHaveClass('hidden', 'md:flex');
    expect(screen.getByRole('link', { name: 'View site' }).parentElement).toHaveClass('hidden', 'md:flex');
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveClass('md:hidden');
  });

  it('starts closed', () => {
    renderChrome();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Editor menu' })).not.toBeInTheDocument();
  });

  it('opens a menu holding the nav links, View site and Sign out', async () => {
    renderChrome();
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));

    const menu = screen.getByRole('navigation', { name: 'Editor menu' });
    for (const label of ['Review', 'Submit', 'Sandbox', 'Settings', 'View site']) {
      expect(within(menu).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(menu).getByRole('button', { name: /Sign out/ })).toBeInTheDocument();
  });

  it('highlights the current tab inside the menu', async () => {
    renderChrome();
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));

    const menu = screen.getByRole('navigation', { name: 'Editor menu' });
    expect(within(menu).getByRole('link', { name: 'Review' })).toHaveClass('bg-primary');
    expect(within(menu).getByRole('link', { name: 'Submit' })).not.toHaveClass('bg-primary');
  });

  it('closes the menu once a link is followed', async () => {
    renderChrome();
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Editor menu' })).getByRole('link', { name: 'Submit' }),
    );

    expect(await screen.findByText('submit page')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Editor menu' })).not.toBeInTheDocument();
  });
});

describe('review filter panel', () => {
  const renderBar = () =>
    render(<FilterBar filters={EMPTY_FILTERS} options={null} onChange={() => {}} />);

  it('stacks search, sort and the buttons below sm', () => {
    const { container } = renderBar();
    const row = screen.getByLabelText('Search').closest('div')?.parentElement;
    expect(row).toHaveClass('flex-col', 'sm:flex-row');
    expect(container.querySelector('.sm\\:min-w-60')).toBeInTheDocument();
  });

  it('puts each filter label above its chips below sm', () => {
    renderBar();
    expect(screen.getByText('Safety')).toHaveClass('w-full', 'sm:w-16');
    expect(screen.getByText('Created', { selector: 'span' })).toHaveClass('w-full', 'sm:w-16');
  });

  it('lets the two date inputs share a line and shrink', () => {
    renderBar();
    for (const label of ['Created from', 'Created to']) {
      expect(screen.getByLabelText(label)).toHaveClass('min-w-0', 'grow', 'basis-32');
    }
  });
});

describe('story card', () => {
  const STORY: AdminStory = {
    originalId: 'r1',
    originalHeadline: 'Coral garden found',
    kidHeadline: 'A secret coral garden!',
    category: 'Environment',
    safety: 'calm',
    status: 'pending_review',
    approvedBy: null,
    createdAt: '2026-09-03T10:00:00.000Z',
    versions: [{
      id: 'a1', originalId: 'r1', ageTarget: 6,
      kidHeadline: 'A secret coral garden!', summary: 'Divers found coral.',
      whatHappened: '', whyItMatters: '', vocab: [], thinkAbout: '',
      audioScript: null, feelingNote: null, safety: 'calm', contentWarnings: null,
      category: 'Environment', readingMinutes: 2, sourceName: 'BBC News',
      sourceUrl: 'https://example.com/original', status: 'pending_review',
      rejectReason: null, editedByHuman: false,
      createdAt: '2026-09-03T10:00:00.000Z', publishedAt: null,
    }],
  } as unknown as AdminStory;

  it('drops the actions under the card content below md', () => {
    render(
      <MemoryRouter>
        <StoryRow story={STORY} selected={false} onSelectedChange={() => {}} actions={{
          onView: () => {}, onPublish: () => {}, onReject: () => {}, onUnpublish: () => {},
          onEdit: () => {}, onRegenerate: () => {}, onDelete: () => {},
        }} />
      </MemoryRouter>,
    );

    const actions = screen.getByRole('button', { name: /View/ }).parentElement;
    expect(actions).toHaveClass('w-full', 'flex-wrap', 'md:w-auto');
  });
});
