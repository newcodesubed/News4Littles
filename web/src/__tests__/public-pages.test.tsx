/** Public pages and shared components — PRD §3. */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryBadge, SafetyBadge } from '../components/Badges';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { StoryCard } from '../components/StoryCard';
import { Podcast } from '../pages/Podcast';
import { Settings } from '../pages/Settings';
import { About } from '../pages/About';
import { SettingsProvider } from '../settings/SettingsContext';
import type { KidArticle } from '../lib/types';

const BASE: KidArticle = {
  id: 'a1', originalId: 'r1', ageTarget: 8,
  kidHeadline: 'A secret coral garden was found', summary: 'Scientists found a coral garden.',
  whatHappened: 'W.', whyItMatters: 'Y.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'T?', feelingNote: null, safety: 'calm', contentWarnings: null,
  category: 'Environment', readingMinutes: 3, sourceName: 'BBC News',
  sourceUrl: 'https://example.com/original', status: 'published', rejectReason: null,
  editedByHuman: false, createdAt: '2026-09-04T10:00:00.000Z', publishedAt: '2026-09-04T10:00:00.000Z',
};
const article = (o: Partial<KidArticle> = {}): KidArticle => ({ ...BASE, ...o });

const mockFetch = (payload: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response));

const renderIn = (ui: React.ReactNode) =>
  render(<MemoryRouter><SettingsProvider>{ui}</SettingsProvider></MemoryRouter>);

beforeEach(() => window.localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('CategoryBadge', () => {
  it.each(['World', 'Science', 'Environment', 'Health', 'Culture', 'Technology', 'Sports', 'Good News'])(
    'renders the %s category', (category) => {
      renderIn(<CategoryBadge category={category} />);
      expect(screen.getByText(category)).toBeInTheDocument();
    });

  it('falls back gracefully for a category the UI does not know', () => {
    renderIn(<CategoryBadge category="Astrology" />);
    expect(screen.getByText('Astrology')).toBeInTheDocument();
  });
});

describe('SafetyBadge', () => {
  it.each([
    ['calm', 'Calm'],
    ['adult-nearby', 'Grown-up nearby'],
    ['skip-young', 'Skip for young kids'],
  ] as const)('%s reads "%s"', (safety, label) => {
    renderIn(<SafetyBadge safety={safety} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('States', () => {
  it('loading is announced to screen readers', () => {
    renderIn(<LoadingState />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('empty state shows its title and body', () => {
    renderIn(<EmptyState title="Nothing here">Come back later.</EmptyState>);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Come back later.')).toBeInTheDocument();
  });

  it('error state is an alert carrying the message', () => {
    renderIn(<ErrorState message="The API is down." />);
    expect(within(screen.getByRole('alert')).getByText('The API is down.')).toBeInTheDocument();
  });
});

describe('StoryCard (§3.3)', () => {
  it('shows headline, summary, reading time and source', () => {
    renderIn(<StoryCard article={article()} />);
    expect(screen.getByText(BASE.kidHeadline)).toBeInTheDocument();
    expect(screen.getByText(BASE.summary)).toBeInTheDocument();
    expect(screen.getByText(/3 min read/)).toBeInTheDocument();
    expect(screen.getByText(/From BBC News/)).toBeInTheDocument();
  });

  it('links to the story detail page', () => {
    renderIn(<StoryCard article={article()} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/story/a1');
  });

  it('carries category and safety badges', () => {
    renderIn(<StoryCard article={article({ safety: 'adult-nearby' })} />);
    expect(screen.getByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('Grown-up nearby')).toBeInTheDocument();
  });
});

describe('Podcast (§3.5)', () => {
  it('shows the episode title from the PRD', async () => {
    mockFetch([article()]);
    renderIn(<Podcast />);
    expect(await screen.findByText(/Today's Curious Kids News/)).toBeInTheDocument();
  });

  it('carries the demo-player notice, since TTS is out of scope', async () => {
    mockFetch([article()]);
    renderIn(<Podcast />);
    expect(await screen.findByText(/Demo player/)).toBeInTheDocument();
  });

  it('builds one segment per published story', async () => {
    mockFetch([article({ id: 'a1' }), article({ id: 'a2', kidHeadline: 'Second story' })]);
    renderIn(<Podcast />);
    expect(await screen.findByText('Story 1')).toBeInTheDocument();
    expect(screen.getByText('Story 2')).toBeInTheDocument();
    expect(screen.getByText('Second story')).toBeInTheDocument();
  });

  it('the placeholder player toggles play and pause', async () => {
    mockFetch([article()]);
    renderIn(<Podcast />);
    const play = await screen.findByRole('button', { name: 'Play' });
    await userEvent.click(play);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('says so when there is no episode yet', async () => {
    mockFetch([]);
    renderIn(<Podcast />);
    expect(await screen.findByText(/No episode today yet/)).toBeInTheDocument();
  });
});

describe('public Settings (§3.6)', () => {
  it('defaults the reading age to 6', async () => {
    mockFetch([article()]);
    renderIn(<Settings />);
    expect(await screen.findByLabelText('Default reading age')).toHaveValue('6');
  });

  it('the slider spans 5 to 14', async () => {
    mockFetch([article()]);
    renderIn(<Settings />);
    const slider = await screen.findByLabelText('Default reading age');
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '14');
  });

  it('lists a toggle per source, on by default', async () => {
    mockFetch([article({ sourceName: 'BBC News' }), article({ id: 'a2', sourceName: 'NPR' })]);
    renderIn(<Settings />);
    expect(await screen.findByLabelText('Show stories from BBC News')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Show stories from NPR')).toHaveAttribute('aria-checked', 'true');
  });

  it('turning a source off flips its switch', async () => {
    mockFetch([article()]);
    renderIn(<Settings />);
    const toggle = await screen.findByLabelText('Show stories from BBC News');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('says the choices never leave this browser', async () => {
    mockFetch([article()]);
    renderIn(<Settings />);
    expect(await screen.findByText(/saved in this browser only/i)).toBeInTheDocument();
  });
});

describe('About (§3.7)', () => {
  it('states the mission and the human-review promise', () => {
    renderIn(<About />);
    expect(screen.getByText(/Our mission/)).toBeInTheDocument();
    expect(screen.getByText(/Editorial guardrails/)).toBeInTheDocument();
  });
});
