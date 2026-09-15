/** Podcast page — playing each story's stored audio script (PRD §3.5). */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Podcast } from '../pages/Podcast';
import { SettingsProvider } from '../settings/SettingsContext';
import type { KidArticle } from '../lib/types';

const BASE: KidArticle = {
  id: 'a1', originalId: 'r1', ageTarget: 8,
  kidHeadline: 'A secret coral garden was found', summary: 'Scientists found a coral garden.',
  whatHappened: 'W.', whyItMatters: 'Y.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'T?', audioScript: null, feelingNote: null, safety: 'calm', contentWarnings: null,
  category: 'Environment', readingMinutes: 3, sourceName: 'BBC News',
  sourceUrl: 'https://example.com/original', status: 'published', rejectReason: null,
  editedByHuman: false, createdAt: '2026-09-04T10:00:00.000Z', publishedAt: '2026-09-04T10:00:00.000Z',
};
const article = (o: Partial<KidArticle> = {}): KidArticle => ({ ...BASE, ...o });

const mockFetch = (payload: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response));

const renderIn = (ui: React.ReactNode) =>
  render(<MemoryRouter><SettingsProvider>{ui}</SettingsProvider></MemoryRouter>);

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  constructor(public text: string) {}
}

let queue: FakeUtterance[];

beforeEach(() => {
  window.localStorage.clear();
  queue = [];
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', {
    speak: (u: FakeUtterance) => queue.push(u),
    cancel: () => { queue = []; },
  });
});
afterEach(() => {
  // Unmount every rendered component here, while the stubbed globals are
  // still in place — RTL's own auto-cleanup afterEach was registered (at
  // import time) before this one, so Vitest's LIFO ordering would otherwise
  // run vi.unstubAllGlobals() first and leave useSpeech's cleanup effect
  // calling a global that no longer exists.
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('Podcast', () => {
  it('shows the stored audio script, not the assembled one', async () => {
    mockFetch([article({ audioScript: 'A robot went down to the reef.' })]);
    renderIn(<Podcast />);

    expect(await screen.findByText(/A robot went down to the reef\./)).toBeInTheDocument();
    expect(screen.queryByText(/Our next story is from/)).not.toBeInTheDocument();
  });

  it('falls back to the assembled script for a story written before audio existed', async () => {
    // Every story published before this feature has audioScript === null, and
    // the page must not go blank for them.
    mockFetch([article({ audioScript: null })]);
    renderIn(<Podcast />);

    expect(await screen.findByText(/Our next story is from/)).toBeInTheDocument();
  });

  it('speaks what it displays', async () => {
    mockFetch([article({ audioScript: 'One. Two.' })]);
    renderIn(<Podcast />);

    await userEvent.click(await screen.findByRole('button', { name: /listen to story 1/i }));

    expect(queue.map((u) => u.text)).toEqual(['One.', 'Two.']);
  });

  it('renders no play button when the browser cannot speak', async () => {
    vi.unstubAllGlobals();
    mockFetch([article({ audioScript: 'One.' })]);
    renderIn(<Podcast />);

    await screen.findByText('One.');
    expect(screen.queryByRole('button', { name: /listen to story/i })).not.toBeInTheDocument();
  });
});
