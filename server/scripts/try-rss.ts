/**
 * STAGE A — a throwaway script to prove the BBC feed fetch works.
 *
 *   npm run try:rss
 *
 * No database, no pipeline, no writes. It fetches the feed, parses it, and
 * prints the three fields that matter for ingestion (§5.2).
 */
import Parser from 'rss-parser';

const FEED_URL = 'https://feeds.bbci.co.uk/news/rss.xml';

async function main(): Promise<void> {
  const parser = new Parser({ timeout: 15_000 });

  console.log(`Fetching ${FEED_URL}\n`);
  const feed = await parser.parseURL(FEED_URL);

  console.log(`Feed title : ${feed.title}`);
  console.log(`Description: ${feed.description}`);
  console.log(`Items      : ${feed.items.length}\n`);
  console.log('─'.repeat(78));

  feed.items.forEach((item, index) => {
    console.log(`\n[${index + 1}]`);
    console.log(`  title    ${item.title}`);
    console.log(`  link     ${item.link}`);
    console.log(`  pubDate  ${item.pubDate}`);
    console.log(`           -> as ISO: ${item.pubDate ? new Date(item.pubDate).toISOString() : '(none)'}`);
  });

  console.log(`\n${'─'.repeat(78)}`);
  console.log('Other fields present on the first item (useful for ingestion):');
  console.log(`  ${Object.keys(feed.items[0] ?? {}).join(', ')}`);
}

main().catch((error: unknown) => {
  console.error('\nFetch failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
