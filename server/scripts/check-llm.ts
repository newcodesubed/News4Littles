/**
 * Live check of the LLM path — PRD §9.1.
 *
 *   npm run llm:check
 *
 * Deliberately standalone and NOT part of `npm test`, because it calls a paid
 * API. Reports exactly what it spent. Writes nothing to the database.
 */
import { openDatabase } from '../src/db/connection.js';
import { LLM_ENABLED, LLM_MODEL, OPENROUTER_KEY } from '../src/env.js';
import { simplifyArticle } from '../src/pipeline/simplifyArticle.js';

const RULE = '─'.repeat(78);

async function usage(): Promise<number> {
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
  });
  if (!res.ok) return Number.NaN;
  return Number(((await res.json()) as { data: { usage: number } }).data.usage);
}

async function main(): Promise<void> {
  console.log(`model        ${LLM_MODEL}`);
  console.log(`key          ${OPENROUTER_KEY ? 'set' : 'NOT SET'}`);
  console.log(`LLM enabled  ${LLM_ENABLED}`);

  if (!LLM_ENABLED) {
    console.log('\nThe LLM path is off, so every article uses the free local fallback.');
    return;
  }

  const db = openDatabase();
  let spent = 0;

  try {
    const raws = db
      .prepare(
        `SELECT r.id, r.headline, r.body, r.topic, r.sourceName, r.sourceUrl
         FROM raw_articles r WHERE r.id NOT LIKE 'sample-%' ORDER BY r.fetchedAt DESC LIMIT 3`,
      )
      .all() as Parameters<typeof simplifyArticle>[1][];

    if (raws.length === 0) {
      console.log('\nNo scraped articles to try. Run `npm run scrape:bbc` first.');
      return;
    }

    for (const raw of raws) {
      console.log(`\n${RULE}`);
      console.log(`ORIGINAL  ${raw.headline}`);

      const llm = await simplifyArticle(db, raw, { ageTarget: 8 });
      const local = await simplifyArticle(db, raw, { ageTarget: 8, forceLocal: true });

      console.log(`${RULE}`);
      console.log(`  local     ${local.article.kidHeadline}`);
      console.log(`            safety ${local.article.safety} · vocab ${local.article.vocab.map((v) => v.word).join(', ')}`);
      console.log(`  ${llm.engine === 'llm' ? 'LLM      ' : 'FELL BACK'} ${llm.article.kidHeadline}`);
      console.log(`            safety ${llm.article.safety} · vocab ${llm.article.vocab.map((v) => v.word).join(', ')}`);
      console.log(`            summary: ${llm.article.summary}`);
      if (llm.engine === 'llm') {
        spent += llm.costUsd ?? 0;
        console.log(`            ${llm.elapsedMs}ms · prompt ${llm.promptSource} · $${(llm.costUsd ?? 0).toFixed(5)}`);
      } else {
        console.log(`            reason: ${llm.fallbackReason}`);
      }
      console.log(`  status    ${llm.article.status} (never auto-published)`);
    }

    // Summed from each response's own usage.cost. The /key endpoint lags by a
    // few seconds, so a before/after diff would under-report a short run.
    console.log(`\n${RULE}`);
    console.log(`Spent on this check: $${spent.toFixed(5)}  (${raws.length} articles)`);
    console.log(`Key total so far   : $${(await usage()).toFixed(5)}  (lags by a few seconds)`);
    console.log('Nothing was written to the database.');
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error('Check failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
