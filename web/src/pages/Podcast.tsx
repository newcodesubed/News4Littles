import { useCallback, useEffect, useState } from 'react';
import { Headphones } from 'lucide-react';
import { PlayBar } from '../components/PlayBar';
import { ErrorState, LoadingState } from '../components/States';
import { episodeAudioUrl, fetchEpisode, fetchPodcastStories, storyAudioUrl } from '../lib/api';
import { useSettings } from '../settings/SettingsContext';
import { useAsync } from '../lib/useAsync';
import { useStoryAudio } from '../lib/useStoryAudio';
import type { KidArticle } from '../lib/types';

/**
 * Podcast — PRD §3.5, layout matching the prototype.
 *
 * Each story is now really read aloud: the server synthesises it through a
 * configured voice provider and this page plays the file. The page does not
 * know or care which provider that is.
 */

/**
 * The script for a story published before `audioScript` existed.
 *
 * MIRRORS `assembleScript` in server/src/services/audioService.ts, which
 * decides what is actually spoken. §2.2's rule is that a child hears exactly
 * what is written, so these two must stay identical — change one, change both.
 */
function segmentScript(article: KidArticle): string {
  const word = article.vocab[0];
  return [
    `Our next story is from ${article.sourceName}. ${article.summary}`,
    word ? `Here's a fun word: "${word.word}" — ${word.definition}` : '',
    `Something to wonder about: ${article.thinkAbout}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * One story, with the script a child hears and a button that plays it.
 *
 * The text shown is the STORED `audioScript`, written and reviewed with the
 * story (§2.2: a person reads every word a child sees, and hearing is seeing),
 * falling back to `segmentScript` for stories published before that field
 * existed. The server resolves the same two cases the same way, so the rule
 * still holds: it plays exactly what is on screen.
 */
function Segment({ article, index, age }: { article: KidArticle; index: number; age: number }) {
  const audio = useStoryAudio(storyAudioUrl(article.id, age));
  const script = article.audioScript ?? segmentScript(article);

  const busy = audio.playing || audio.loading;
  const status =
    audio.error ??
    (audio.loading
      ? 'Getting this story ready…'
      : audio.playing
        ? `Playing story ${index + 1}.`
        : 'Press play to hear this story.');

  // The whole card warms up rather than the words highlighting: the audio carries no sentence timings.
  return (
    <li
      className={`rounded-2xl p-5 border transition duration-300 ${
        audio.playing
          ? 'bg-surface-sun border-primary/40 shadow-pop scale-[1.015]'
          : 'bg-card border-border shadow-soft'
      }`}
    >
      <div className="mb-1 flex items-center gap-2 text-xs font-bold text-primary">
        Story {index + 1}
        {audio.playing && (
          <span aria-hidden className="sound-bars">
            <span />
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
      <h3 className="font-display text-lg mb-3">{article.kidHeadline}</h3>

      <PlayBar
        label={busy ? `Stop story ${index + 1}` : `Listen to story ${index + 1}`}
        status={status}
        progress={audio.progress}
        playing={audio.playing}
        loading={audio.loading}
        onToggle={busy ? audio.stop : audio.play}
      />

      <p className="text-sm text-foreground/70 leading-relaxed mt-4">{script}</p>
    </li>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatEpisodeDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

type Notice = 'changed' | 'failed' | null;

const NOTICE_TEXT: Record<Exclude<Notice, null>, string> = {
  changed: 'New stories just arrived! Press play to hear them.',
  failed: 'The episode could not be played right now. Please try again in a moment.',
};

const EPISODE_UNAVAILABLE = 'The episode could not be loaded right now. Please try again in a moment.';

function EpisodePlayer({
  audioKey,
  age,
  episodeLoading,
  episodeFailed,
  hasStories,
  notice,
  onPlay,
  onFailed,
}: {
  audioKey: string | null;
  age: number;
  episodeLoading: boolean;
  episodeFailed: boolean;
  hasStories: boolean;
  notice: Notice;
  onPlay: () => void;
  onFailed: (audioKey: string) => void;
}) {
  const audio = useStoryAudio(audioKey ? episodeAudioUrl(audioKey, age) : null);

  useEffect(() => {
    if (audio.status === 'error' && audioKey) onFailed(audioKey);
  }, [audio.status, audioKey, onFailed]);

  const busy = audio.playing || audio.loading;
  const status = notice
    ? NOTICE_TEXT[notice]
    : episodeLoading
      ? 'Getting today’s episode ready…'
      : episodeFailed
        ? EPISODE_UNAVAILABLE
        : !hasStories
        ? 'No episode yet.'
        : !audioKey
          ? "Listening isn't switched on right now."
          : audio.loading
            ? 'Getting today’s episode ready…'
            : audio.playing
              ? 'Playing today’s episode.'
              : 'Press play to hear all of today’s stories in one go.';

  return (
    <PlayBar
      label={busy ? 'Stop episode' : 'Play episode'}
      status={status}
      progress={audio.progress}
      playing={audio.playing}
      // The first visitor of a new episode waits while it is written; the bar spins, the stories below don't.
      loading={audio.loading || episodeLoading}
      disabled={!audioKey}
      testId="episode"
      onToggle={
        busy
          ? audio.stop
          : () => {
              onPlay();
              audio.play();
            }
      }
    />
  );
}

export function Podcast() {
  const { readingAge } = useSettings();
  const [reloads, setReloads] = useState(0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // Two requests: the stories are a quick read, the episode may wait on the model.
  const stories = useAsync(() => fetchPodcastStories(readingAge), [readingAge]);
  const state = useAsync(() => fetchEpisode(readingAge), [readingAge, reloads]);

  const episode = state.status === 'ready' ? state.data : null;
  // Once the episode arrives its own list wins: it is the set of stories the audio was made from.
  const day = episode ?? (stories.status === 'ready' ? stories.data : null);
  const articles: KidArticle[] = day?.articles ?? [];
  const minutes = articles.reduce((total, a) => total + a.readingMinutes, 0);

  const notice: Notice =
    failedKey && episode ? (episode.audioKey === failedKey ? 'failed' : 'changed') : null;

  const date = day?.date ?? null;
  const label =
    date && date !== todayIso()
      ? `Latest episode · ${formatEpisodeDate(date)}`
      : `Daily Episode · ${formatEpisodeDate(date ?? todayIso())}`;

  const handleFailed = useCallback((key: string) => {
    setFailedKey(key);
    setReloads((n) => n + 1);
  }, []);

  return (
    <div>
      <section className="bg-gradient-sky">
        <div className="container py-12 md:py-16">
          <div className="bg-card rounded-3xl shadow-card border border-border p-6 md:p-10 max-w-3xl mx-auto">
            <div className="flex items-center gap-2 text-xs font-bold text-primary uppercase tracking-wider mb-3">
              <Headphones className="w-4 h-4" /> {label}
            </div>

            <h1 className="font-display text-3xl md:text-4xl leading-tight mb-3">
              Today's Curious Kids News — Bright news from around the world
            </h1>

            <p className="text-muted-foreground mb-6">
              ~{minutes} minutes · {articles.length} short{' '}
              {articles.length === 1 ? 'story' : 'stories'}
            </p>

            <EpisodePlayer
              audioKey={episode?.audioKey ?? null}
              age={readingAge}
              episodeLoading={state.status === 'loading'}
              episodeFailed={state.status === 'error'}
              hasStories={articles.length > 0}
              notice={notice}
              onPlay={() => setFailedKey(null)}
              onFailed={handleFailed}
            />
          </div>
        </div>
      </section>

      <div className="container max-w-3xl py-10 space-y-8">
        {!day && stories.status === 'loading' && <LoadingState label="Getting today’s stories…" />}
        {!day && stories.status === 'error' && <ErrorState message={stories.message} />}

        {day && (
          <div>
            <h2 className="font-display text-2xl mb-4">Today's stories</h2>

            {articles.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">
                No episode today yet. Once today's stories are published, they'll appear here as
                segments.
              </p>
            ) : (
              <ol className="space-y-4">
                {articles.map((article, index) => (
                  <Segment key={article.id} article={article} index={index} age={readingAge} />
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
