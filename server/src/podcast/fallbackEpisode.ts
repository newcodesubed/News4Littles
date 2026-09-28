import type { EpisodeStory } from './episodePrompt.js';

const CLOSING =
  "That's all for today, friends. Remember: it's okay to feel curious, it's okay to ask " +
  "questions, and it's wonderful to learn something new. Talk to a grown-up about your " +
  'favorite story today. See you tomorrow!';

function segment(story: EpisodeStory, index: number): string {
  if (!story.hasOwnScript) return `Story ${index + 1}. ${story.script}`;

  return (
    `Story ${index + 1}. This one comes from ${story.sourceName}. ${story.script} ` +
    `Something to wonder about... ${story.thinkAbout}`
  );
}

export function buildFallbackEpisode(stories: EpisodeStory[]): string {
  const count = stories.length === 1 ? 'one short story' : `${stories.length} short stories`;

  return [
    `Hi friends! Welcome to News for Curious Kids. Today we have ${count}.`,
    ...stories.map(segment),
    CLOSING,
  ].join('\n\n');
}
