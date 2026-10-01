/**
 * Prints what the scraper extracts from one BBC article page — the first thing
 * to run when BBC changes its markup and stories start arriving thin.
 *
 *   npm run try:bbc -- https://www.bbc.co.uk/news/articles/cv8e30enrkxyo
 *
 * No database, no writes.
 */
import { fetchBbcArticleText, isBbcArticleUrl } from '../src/ingestion/bbcArticle.js';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) throw new Error('Pass an article URL: npm run try:bbc -- <url>');
  if (!isBbcArticleUrl(url)) {
    console.warn('Not an /articles/ URL: the scraper skips links like this one.\n');
  }

  const text = await fetchBbcArticleText(url);
  const paragraphs = text.split('\n\n');

  console.log(`${paragraphs.length} paragraphs, ${text.length} characters\n`);
  console.log('─'.repeat(78));
  console.log(text);
}

main().catch((error: unknown) => {
  console.error('Extraction failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
