/** About — PRD §3.7. */
export function About() {
  return (
    <article className="max-w-2xl">
      <h1 className="text-4xl leading-tight font-bold">About News4Littles</h1>

      <p className="mt-5 text-lg leading-relaxed text-ink-soft">
        Children hear about the world whether or not anyone explains it to them. News4Littles takes
        real stories from trusted news sources and rewrites them for young readers — truthfully,
        calmly, and without the frightening parts that a headline is designed to deliver.
      </p>

      <h2 className="mt-10 text-2xl font-bold">How a story gets here</h2>
      <ol className="mt-4 space-y-4 text-lg text-ink-soft">
        <li className="rounded-2xl border border-paper-deep bg-white p-5">
          <span className="font-bold text-ink">1. We gather.</span> Stories come from trusted news
          organisations, not from social media.
        </li>
        <li className="rounded-2xl border border-paper-deep bg-white p-5">
          <span className="font-bold text-ink">2. We rewrite.</span> Each story is retold in shorter
          sentences and everyday words, with the facts kept exactly as they were reported.
        </li>
        <li className="rounded-2xl border border-paper-deep bg-white p-5">
          <span className="font-bold text-ink">3. A grown-up checks it.</span> Every story is read by
          a human editor before a child ever sees it. Nothing is published automatically.
        </li>
      </ol>

      <h2 className="mt-10 text-2xl font-bold">Feeling notes</h2>
      <p className="mt-3 text-lg leading-relaxed text-ink-soft">
        Some true stories are still hard ones. When a story might worry a reader, we add a short
        feeling note — a few reassuring words, and a nudge to read it with a grown-up nearby. Calm
        stories don’t get one, because most of the news really is fine.
      </p>

      <h2 className="mt-10 text-2xl font-bold">For grown-ups</h2>
      <p className="mt-3 text-lg leading-relaxed text-ink-soft">
        Every story links back to the original report, so you can read the full version yourself. You
        can also set a reading age and choose which sources appear, over in{' '}
        <a href="/settings" className="font-semibold text-brand-deep underline">
          Settings
        </a>
        .
      </p>
    </article>
  );
}
