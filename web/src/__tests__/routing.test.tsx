/** Route table and public chrome — PRD §3.1, §4.1. */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { SettingsProvider } from '../settings/SettingsContext';

const mockFetch = (payload: unknown = []) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response));

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsProvider><AdminAuthProvider><App /></AdminAuthProvider></SettingsProvider>
    </MemoryRouter>,
  );

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); mockFetch(); });
afterEach(() => vi.unstubAllGlobals());

describe('the five public routes (§3.1)', () => {
  it.each([
    ['/', /The world,/],
    ['/podcast', /Today's Curious Kids News/],
    ['/about', /A kinder way for kids/],
  ])('%s renders', async (path, text) => {
    at(path);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('/settings renders', async () => {
    at('/settings');
    // "Settings" also appears in the nav, so match the page heading itself.
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
  });

  it('/story/:id renders the detail page', async () => {
    mockFetch({
      id: 'a1', originalId: 'r1', ageTarget: 8, kidHeadline: 'A coral story', summary: 'S.',
      whatHappened: 'W.', whyItMatters: 'Y.', vocab: [], thinkAbout: 'T?', feelingNote: null,
      safety: 'calm', contentWarnings: null, category: 'World', readingMinutes: 3,
      sourceName: 'BBC News', sourceUrl: 'https://x', status: 'published', rejectReason: null,
      editedByHuman: false, createdAt: '2026-09-04T10:00:00.000Z', publishedAt: '2026-09-04T10:00:00.000Z',
    });
    at('/story/a1');
    expect(await screen.findByText('A coral story')).toBeInTheDocument();
  });
});

describe('public chrome', () => {
  it('shows the wordmark and the four public nav links', async () => {
    at('/');
    await screen.findByText(/The world,/);
    expect(screen.getAllByText('Curious Kids').length).toBeGreaterThan(0);
    for (const label of ['Today', 'Podcast', 'About', 'Settings']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it('does not advertise admin routes to readers', async () => {
    at('/');
    await screen.findByText(/The world,/);
    expect(screen.queryByRole('link', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Submit' })).not.toBeInTheDocument();
  });
});

describe('admin routes (§4.1)', () => {
  it.each(['/admin', '/admin/review', '/admin/submit', '/admin/settings'])(
    '%s redirects a signed-out visitor to login', async (path) => {
      at(path);
      expect(await screen.findByText('Editor sign-in')).toBeInTheDocument();
    });

  it('/admin/login is reachable without a session', async () => {
    at('/admin/login');
    expect(await screen.findByText('Editor sign-in')).toBeInTheDocument();
  });
});

describe('unknown routes', () => {
  it('show a not-found page, not a blank screen', async () => {
    at('/no-such-page');
    expect(await screen.findByText(/Page not found/)).toBeInTheDocument();
  });
});
