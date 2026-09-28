/** Podcast page — playing each story's stored audio script (PRD §3.5). */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Podcast } from '../pages/Podcast';
import { SettingsProvider } from '../settings/SettingsContext';
import type { KidArticle, PodcastEpisode } from '../lib/types';

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

const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

const EPISODE_KEY = `${'e'.repeat(64)}.mp3`;

const episode = (o: Partial<PodcastEpisode> = {}): PodcastEpisode => ({
  date: TODAY, articles: [article()], script: 'Hello curious friends! Today we have one story.',
  source: 'llm', audioKey: EPISODE_KEY, ...o,
});

/** Answers each fetch with the next payload, repeating the last one. */
const mockFetchSequence = (...payloads: unknown[]) => {
  const fetchMock = vi.fn(async () => {
    const payload = payloads.length > 1 ? payloads.shift() : payloads[0];
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const episodeAudio = () => FakeAudio.instances.find((a) => a.src.includes('/api/podcast/audio/'))!;

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
  duration = NaN;
  ontimeupdate: (() => void) | null = null;
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
    mockFetch(episode({ articles: [article({ audioScript: 'A robot went down to the reef.' })] }));
    renderIn(<Podcast />);

    expect(await screen.findByText(/A robot went down to the reef\./)).toBeInTheDocument();
    expect(screen.queryByText(/Our next story is from/)).not.toBeInTheDocument();
  });

  it('falls back to the assembled script for a story written before audio existed', async () => {
    // Every story published before this feature has audioScript === null, and
    // the page must not go blank for them.
    mockFetch(episode({ articles: [article({ audioScript: null })] }));
    renderIn(<Podcast />);

    expect(await screen.findByText(/Our next story is from/)).toBeInTheDocument();
  });

  it('asks the server for this story at this reading age', async () => {
    // The audio says what the on-screen version says, so the age is part of
    // the request — not just of the text fetch.
    mockFetch(episode({ articles: [article({ id: 'a1', audioScript: 'One. Two.' })] }));
    renderIn(<Podcast />);

    await userEvent.click(await screen.findByRole('button', { name: /listen to story 1/i }));

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.last.src).toMatch(/\/api\/articles\/a1\/audio\?age=\d+$/);
    expect(FakeAudio.last.play).toHaveBeenCalled();
  });

  it('offers a play button even before the browser knows the audio exists', async () => {
    // Whether a voice is configured is the server's business; the page finds
    // out by asking, so the button is always offered.
    mockFetch(episode({ articles: [article({ audioScript: 'One.' })] }));
    renderIn(<Podcast />);

    expect(await screen.findByRole('button', { name: /listen to story 1/i })).toBeInTheDocument();
  });

  it('says so, gently, when a story cannot be read aloud', async () => {
    mockFetch(episode({ articles: [article({ audioScript: 'One.' })] }));
    renderIn(<Podcast />);
    await userEvent.click(await screen.findByRole('button', { name: /listen to story 1/i }));

    await act(async () => FakeAudio.last.onerror?.());

    expect(await screen.findByText(/could not be read aloud/i)).toBeInTheDocument();
  });

  it('lights up the story being read aloud, and settles once it ends', async () => {
    mockFetch(episode({ articles: [article({ audioScript: 'One.' })] }));
    renderIn(<Podcast />);
    await userEvent.click(await screen.findByRole('button', { name: /listen to story 1/i }));

    const card = screen.getByRole('listitem');
    // Loading is not playing: the card waits for the voice, not for the click.
    expect(card).toHaveClass('bg-card');
    expect(card.querySelector('.sound-bars')).toBeNull();

    await act(async () => FakeAudio.last.onplaying?.());
    expect(card).toHaveClass('bg-surface-sun', 'shadow-pop');
    expect(card.querySelector('.sound-bars')).not.toBeNull();

    await act(async () => FakeAudio.last.onended?.());
    expect(card).toHaveClass('bg-card');
    expect(card.querySelector('.sound-bars')).toBeNull();
  });
});

describe('Podcast — the whole episode', () => {
  it('shows what the child will hear', async () => {
    mockFetch(episode({ script: 'Did you know a robot can swim? Welcome to News for Curious Kids!' }));
    renderIn(<Podcast />);

    expect(await screen.findByRole('heading', { name: /What you'll hear/ })).toBeInTheDocument();
    expect(screen.getByText(/Did you know a robot can swim\?/)).toBeInTheDocument();
    // The old fixed intro would no longer match the audio.
    expect(screen.queryByText(/Friendly intro/)).not.toBeInTheDocument();
  });

  it('plays this exact episode straight from the click, with no fetch first', async () => {
    // Browsers only let audio start from a click; waiting on a network
    // round-trip first can get the play blocked (spec §2.1).
    const fetchMock = mockFetchSequence(episode());
    renderIn(<Podcast />);
    const play = await screen.findByRole('button', { name: 'Play episode' });
    const fetchesBefore = fetchMock.mock.calls.length;

    await userEvent.click(play);

    expect(fetchMock.mock.calls.length).toBe(fetchesBefore);
    expect(episodeAudio().src).toMatch(new RegExp(`/api/podcast/audio/${EPISODE_KEY}\\?age=\\d+$`));
    expect(episodeAudio().play).toHaveBeenCalled();
  });

  it('moves the progress bar as the episode plays', async () => {
    mockFetch(episode());
    renderIn(<Podcast />);
    await userEvent.click(await screen.findByRole('button', { name: 'Play episode' }));

    await act(async () => episodeAudio().onplaying?.());
    episodeAudio().duration = 200;
    episodeAudio().currentTime = 100;
    await act(async () => episodeAudio().ontimeupdate?.());

    expect(screen.getByTestId('episode-progress')).toHaveStyle({ width: '50%' });
    expect(screen.getByRole('button', { name: 'Stop episode' })).toBeInTheDocument();
  });

  it('picks up new stories when the episode changed after the page loaded', async () => {
    mockFetchSequence(
      episode(),
      episode({ audioKey: `${'f'.repeat(64)}.mp3`, script: 'Welcome! Today we have two stories.' }),
    );
    renderIn(<Podcast />);
    await userEvent.click(await screen.findByRole('button', { name: 'Play episode' }));

    // The server answered 409; an <audio> element only ever sees an error.
    await act(async () => episodeAudio().onerror?.());

    expect(await screen.findByText(/New stories just arrived! Press play to hear them\./)).toBeInTheDocument();
    expect(screen.getByText(/Today we have two stories\./)).toBeInTheDocument();
  });

  it('says so, gently, when the episode really could not be played', async () => {
    mockFetchSequence(episode(), episode());
    renderIn(<Podcast />);
    await userEvent.click(await screen.findByRole('button', { name: 'Play episode' }));

    await act(async () => episodeAudio().onerror?.());

    expect(await screen.findByText(/could not be played right now/i)).toBeInTheDocument();
  });

  it('says the episode is on its way while it loads, not that there is none', async () => {
    // The first load can take seconds while the server writes a new episode.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderIn(<Podcast />);

    expect(screen.getByTestId('episode-status')).toHaveTextContent(/Getting today’s episode ready/);
    expect(screen.queryByText('No episode yet.')).not.toBeInTheDocument();
  });

  it('says the episode is on its way while it is fetched again after a failed play', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ ok: true, status: 200, json: async () => episode() } as unknown as Response)
        : new Promise(() => {});
    }));
    renderIn(<Podcast />);
    await userEvent.click(await screen.findByRole('button', { name: 'Play episode' }));

    await act(async () => episodeAudio().onerror?.());

    expect(screen.getByTestId('episode-status')).toHaveTextContent(/Getting today’s episode ready/);
    expect(screen.queryByText('No episode yet.')).not.toBeInTheDocument();
  });

  it('labels an episode from an earlier day as the latest, not today\'s', async () => {
    mockFetch(episode({ date: '2020-01-01' }));
    renderIn(<Podcast />);

    expect(await screen.findByText(/Latest episode/)).toBeInTheDocument();
  });

  it('calls a today episode the daily episode', async () => {
    mockFetch(episode());
    renderIn(<Podcast />);

    expect(await screen.findByText(/Daily Episode/)).toBeInTheDocument();
  });

  it('cannot be played when speech is off on the server', async () => {
    mockFetch(episode({ audioKey: null }));
    renderIn(<Podcast />);

    expect(await screen.findByRole('button', { name: 'Play episode' })).toBeDisabled();
  });

  it('cannot be played, and says so, when there are no stories yet', async () => {
    mockFetch(episode({ date: null, articles: [], script: null, source: null, audioKey: null }));
    renderIn(<Podcast />);

    expect(await screen.findByText(/No episode today yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play episode' })).toBeDisabled();
  });
});
