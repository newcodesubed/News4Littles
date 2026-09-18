/** Podcast page — playing each story's stored audio script (PRD §3.5). */
import { act, cleanup, render, screen } from '@testing-library/react';
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

/** jsdom has no media pipeline; see use-story-audio.test.ts. */
class FakeAudio {
  static instances: FakeAudio[] = [];

  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  currentTime = 0;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }

  static get last(): FakeAudio {
    return FakeAudio.instances[FakeAudio.instances.length - 1];
  }
}

beforeEach(() => {
  window.localStorage.clear();
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  // Unmount every rendered component here, while the stubbed globals are
  // still in place — RTL's own auto-cleanup afterEach was registered (at
  // import time) before this one, so Vitest's LIFO ordering would otherwise
  // run vi.unstubAllGlobals() first and leave the audio hook's cleanup effect
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

  it('asks the server for this story at this reading age', async () => {
    // The audio says what the on-screen version says, so the age is part of
    // the request — not just of the text fetch.
    mockFetch([article({ id: 'a1', audioScript: 'One. Two.' })]);
    renderIn(<Podcast />);

    await userEvent.click(await screen.findByRole('button', { name: /listen to story 1/i }));

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.last.src).toMatch(/\/api\/articles\/a1\/audio\?age=\d+$/);
    expect(FakeAudio.last.play).toHaveBeenCalled();
  });

  it('offers a play button even before the browser knows the audio exists', async () => {
    // Whether a voice is configured is the server's business; the page finds
    // out by asking, so the button is always offered.
    mockFetch([article({ audioScript: 'One.' })]);
    renderIn(<Podcast />);

    expect(await screen.findByRole('button', { name: /listen to story 1/i })).toBeInTheDocument();
  });

  it('says so, gently, when a story cannot be read aloud', async () => {
    mockFetch([article({ audioScript: 'One.' })]);
    renderIn(<Podcast />);
    await userEvent.click(await screen.findByRole('button', { name: /listen to story 1/i }));

    await act(async () => FakeAudio.last.onerror?.());

    expect(await screen.findByText(/could not be read aloud/i)).toBeInTheDocument();
  });
});
