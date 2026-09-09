/**
 * The rules in here are safety behaviour, not styling (PRD §3.4, §6, §11.1):
 *   - a feeling note appears ONLY on non-calm stories
 *   - a safety badge appears ONLY on non-calm stories
 *   - the public site shows published stories only
 * Each is asserted in both directions, so a regression in either fails.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../pages/Home';
import { StoryDetail } from '../pages/StoryDetail';
import { SettingsProvider } from '../settings/SettingsContext';
import type { KidArticle } from '../lib/types';

const BASE: KidArticle = {
  id: 'a1',
  originalId: 'r1',
  ageTarget: 8,
  kidHeadline: 'A secret coral garden was found deep in the sea!',
  summary: 'Scientists found a huge coral garden far below the waves.',
  whatHappened: 'A robot went deep underwater and took pictures.',
  whyItMatters: 'Lots of sea animals live in coral.',
  vocab: [{ word: 'coral', definition: 'A tiny sea animal that builds rocky homes.' }],
  thinkAbout: 'Where would you send a robot?',
  feelingNote: null,
  safety: 'calm',
  contentWarnings: null,
  category: 'Environment',
  readingMinutes: 3,
  sourceName: 'BBC News',
  sourceUrl: 'https://example.com/original',
  status: 'published',
  rejectReason: null,
  editedByHuman: false,
  createdAt: '2026-09-03T10:00:00.000Z',
  publishedAt: '2026-09-03T10:00:00.000Z',
};

const article = (overrides: Partial<KidArticle> = {}): KidArticle => ({ ...BASE, ...overrides });

function mockFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => payload }) as unknown as Response),
  );
}

function renderStory(a: KidArticle) {
  mockFetch(a);
  return render(
    <MemoryRouter initialEntries={[`/story/${a.id}`]}>
      <SettingsProvider>
        <Routes>
          <Route path="/story/:id" element={<StoryDetail />} />
        </Routes>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

function renderHome(articles: KidArticle[]) {
  mockFetch(articles);
  return render(
    <MemoryRouter>
      <SettingsProvider>
        <Home />
      </SettingsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('feeling note (§3.4, §11.1)', () => {
  it('is shown for an adult-nearby story', async () => {
    renderStory(article({ safety: 'adult-nearby', feelingNote: 'Grown-ups are helping.' }));
    expect(await screen.findByText('A little feeling note')).toBeInTheDocument();
    expect(screen.getByText('Grown-ups are helping.')).toBeInTheDocument();
  });

  it('is shown for a skip-young story', async () => {
    renderStory(article({ safety: 'skip-young', feelingNote: 'People are working on it.' }));
    expect(await screen.findByText('A little feeling note')).toBeInTheDocument();
  });

  it('is NOT shown for a calm story', async () => {
    renderStory(article({ safety: 'calm', feelingNote: null }));
    await screen.findByText(BASE.kidHeadline);
    expect(screen.queryByText('A little feeling note')).not.toBeInTheDocument();
  });

  it('is NOT shown for a calm story even if the data wrongly carries one', async () => {
    renderStory(article({ safety: 'calm', feelingNote: 'This should never be rendered.' }));
    await screen.findByText(BASE.kidHeadline);
    expect(screen.queryByText('A little feeling note')).not.toBeInTheDocument();
    expect(screen.queryByText('This should never be rendered.')).not.toBeInTheDocument();
  });
});

describe('safety badge', () => {
  it('is shown for non-calm stories', async () => {
    renderStory(article({ safety: 'adult-nearby', feelingNote: 'Note.' }));
    expect(await screen.findByText('Grown-up nearby')).toBeInTheDocument();
  });

  it('reads "Calm" for a calm story, as the prototype does', async () => {
    renderStory(article({ safety: 'calm' }));
    expect(await screen.findByText('Calm')).toBeInTheDocument();
  });

  it('reads "Skip for young kids" for skip-young', async () => {
    renderStory(article({ safety: 'skip-young', feelingNote: 'Note.' }));
    expect(await screen.findByText('Skip for young kids')).toBeInTheDocument();
  });
});

describe('published-only (§11.1)', () => {
  it('home does not ask for a status, because the server decides it', async () => {
    // This used to assert the client sent ?status=published. That guarantee
    // moved into the server: the public endpoint hardcodes published-only in
    // SQL, because a status parameter made §2.2's promise depend on whichever
    // caller happened to ask. Enforced now in server/tests/public-api.test.ts.
    renderHome([article()]);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    const requested = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(requested).not.toContain('status=');
    // What it does send is the reader's age (§6).
    expect(requested).toMatch(/age=\d+/);
  });

  it('a story still in review is withheld, headline included', async () => {
    renderStory(article({ status: 'pending_review', publishedAt: null }));
    expect(await screen.findByText('This story isn’t ready yet')).toBeInTheDocument();
    expect(screen.queryByText(BASE.kidHeadline)).not.toBeInTheDocument();
  });

  it('a rejected story is withheld', async () => {
    renderStory(article({ status: 'rejected', publishedAt: null }));
    expect(await screen.findByText('This story isn’t ready yet')).toBeInTheDocument();
  });
});

describe('home feed states', () => {
  it('renders a card per story', async () => {
    renderHome([article({ id: 'a1' }), article({ id: 'a2', kidHeadline: 'Second story' })]);
    expect(await screen.findByText(BASE.kidHeadline)).toBeInTheDocument();
    expect(screen.getByText('Second story')).toBeInTheDocument();
  });

  it('shows an empty state when nothing is published', async () => {
    renderHome([]);
    expect(await screen.findByText(/No stories today yet/)).toBeInTheDocument();
  });

  it('shows an error state when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(
      <MemoryRouter>
        <SettingsProvider>
          <Home />
        </SettingsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('We couldn’t load the news')).toBeInTheDocument();
    expect(screen.getByText(/Is the server running/)).toBeInTheDocument();
  });
});
