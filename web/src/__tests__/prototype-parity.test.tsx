/**
 * Structural parity with the reference prototype.
 *
 * Each expected class string below was lifted from the prototype's compiled
 * bundle (news4littles.lovable.app/assets/index-B6RoJmII.js). If a refactor
 * drifts from the prototype's layout, these fail.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../components/Header';
import { Home } from '../pages/Home';
import { StoryDetail } from '../pages/StoryDetail';
import { SettingsProvider } from '../settings/SettingsContext';
import type { KidArticle } from '../lib/types';

const ARTICLE: KidArticle = {
  id: 'a1', originalId: 'r1', ageTarget: 8,
  kidHeadline: 'A secret coral garden was found deep in the sea!',
  summary: 'Scientists found a huge coral garden far below the waves.',
  whatHappened: 'A robot went deep underwater.', whyItMatters: 'Sea animals live in coral.',
  vocab: [{ word: 'coral', definition: 'A tiny sea animal.' }],
  thinkAbout: 'Where would you send a robot?', feelingNote: null,
  safety: 'calm', contentWarnings: null, category: 'Environment', readingMinutes: 3,
  sourceName: 'BBC News', sourceUrl: 'https://example.com/original',
  status: 'published', rejectReason: null, editedByHuman: false,
  createdAt: '2026-09-03T10:00:00.000Z', publishedAt: '2026-09-03T10:00:00.000Z',
};

function mockFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response));
}

afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode, path = '/') =>
  render(<MemoryRouter initialEntries={[path]}><SettingsProvider>{ui}</SettingsProvider></MemoryRouter>);

describe('header', () => {
  it('is sticky, blurred and 16 units tall, as the prototype', () => {
    const { container } = wrap(<Header />);
    const header = container.querySelector('header')!;
    expect(header.className).toBe('sticky top-0 z-40 backdrop-blur-md bg-background/80 border-b border-border');
    expect(container.querySelector('.container')!.className).toContain('h-16');
  });

  it('shows the prototype wordmark', () => {
    wrap(<Header />);
    expect(screen.getByText('News for')).toBeInTheDocument();
    expect(screen.getByText('Curious Kids')).toBeInTheDocument();
  });
});

describe('home hero', () => {
  it('uses the prototype gradient, grid and headline', async () => {
    mockFetch([ARTICLE]);
    const { container } = wrap(<Home />);
    await screen.findByText(ARTICLE.kidHeadline);

    expect(container.querySelector('.bg-gradient-hero')).toBeTruthy();
    expect(container.querySelector('.bg-gradient-hero .container')!.className)
      .toBe('container grid md:grid-cols-2 gap-10 py-12 md:py-20 items-center');

    const h1 = container.querySelector('h1')!;
    expect(h1.className).toBe('font-display text-5xl md:text-6xl leading-[1.05] mb-5');
    expect(h1.textContent).toBe('The world, explained kindly for curious kids.');

    expect(screen.getByText("Read today's news").className)
      .toBe('inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-3 rounded-full font-bold shadow-pop hover:scale-105 transition-transform');
  });

  it('renders the prototype hero image with its alt text', async () => {
    mockFetch([ARTICLE]);
    wrap(<Home />);
    const img = await screen.findByAltText('A friendly newspaper under a sunny sky with floating world icons');
    expect(img.getAttribute('width')).toBe('1536');
    expect(img.className).toBe('rounded-3xl shadow-card w-full h-auto');
  });

  it('lays stories out on the prototype 1/2/3-column grid', async () => {
    mockFetch([ARTICLE]);
    const { container } = wrap(<Home />);
    await screen.findByText(ARTICLE.kidHeadline);
    expect(container.querySelector('#today > div.grid')!.className)
      .toBe('grid sm:grid-cols-2 lg:grid-cols-3 gap-5');
  });

  it('offers the prototype category filter chips', async () => {
    mockFetch([ARTICLE]);
    wrap(<Home />);
    await screen.findByText(ARTICLE.kidHeadline);
    for (const c of ['All', 'World', 'Science', 'Environment', 'Health', 'Culture', 'Technology', 'Sports', 'Good News']) {
      expect(screen.getAllByText(c).length).toBeGreaterThan(0);
    }
  });

  it('uses the prototype story-card shell', async () => {
    mockFetch([ARTICLE]);
    const { container } = wrap(<Home />);
    await screen.findByText(ARTICLE.kidHeadline);
    expect(container.querySelector('a[href="/story/a1"]')!.className)
      .toBe('group block bg-card rounded-3xl p-6 shadow-soft hover:shadow-card transition-all hover:-translate-y-1 border border-border/60');
  });
});

describe('story detail', () => {
  const renderDetail = (a: KidArticle) => {
    mockFetch(a);
    return wrap(<Routes><Route path="/story/:id" element={<StoryDetail />} /></Routes>, `/story/${a.id}`);
  };

  it('uses the prototype article container and headings', async () => {
    const { container } = renderDetail(ARTICLE);
    await screen.findByText(ARTICLE.kidHeadline);
    expect(container.querySelector('article')!.className).toBe('container max-w-3xl py-10');
    expect(container.querySelector('h1')!.className).toBe('font-display text-4xl md:text-5xl leading-tight mb-5');
    expect(screen.getByText('Back to today')).toBeInTheDocument();
    expect(screen.getByText('For age 8+')).toBeInTheDocument();
  });

  it('tints Words to know mint and Think about sun, as the prototype', async () => {
    const { container } = renderDetail(ARTICLE);
    await screen.findByText('Words to know');
    expect(container.querySelector('.bg-surface-mint')!.className).toBe('bg-surface-mint rounded-3xl p-6 my-8');
    expect(container.querySelector('.bg-surface-sun')!.className).toBe('bg-surface-sun rounded-3xl p-6 my-8 flex gap-3');
    expect(screen.getByText('Something to think about')).toBeInTheDocument();
  });

  it('tints the feeling note sky-blue, as the prototype', async () => {
    const { container } = renderDetail({ ...ARTICLE, safety: 'adult-nearby', feelingNote: 'All is well.' });
    await screen.findByText('A little feeling note');
    expect(container.querySelector('.bg-surface-sky')!.className).toBe('bg-surface-sky rounded-3xl p-5 mb-8 flex gap-3');
  });

  it('credits the source the prototype way', async () => {
    renderDetail(ARTICLE);
    expect(await screen.findByText(/Original story from/)).toBeInTheDocument();
    expect(screen.getByText('BBC News')).toBeInTheDocument();
  });
});
