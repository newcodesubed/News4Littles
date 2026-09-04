/**
 * Runnable demo of the local pipeline (PRD §6 + §9.2).
 *
 *   npm run pipeline:demo            # uses app_settings.defaultAge (6)
 *   npm run pipeline:demo -- --age 12
 *
 * Feeds three fixture articles — 0, 2 and 4 deny-list terms — through the real
 * pipeline and prints each resulting KidArticle. Reads the deny-list from
 * guard_config, so editing it in the database changes what you see here.
 *
 * Nothing is written to the database. Fixtures are invented placeholders.
 */
import { openDatabase } from '../src/db/connection.js';
import {
  loadLocalPipelineConfig,
  simplifyLocally,
  type RawArticleInput,
} from '../src/pipeline/localPipeline.js';

const FIXTURES: RawArticleInput[] = [
  {
    id: 'demo-calm',
    sourceName: 'BBC News',
    sourceUrl: 'https://example.com/demo/reef',
    topic: 'Environment',
    headline: 'Survey team documents uncharted deep-water coral reef — researchers call it remarkable',
    body:
      'A survey team has actually documented an extensive cold-water coral reef at a depth of nine hundred metres, using a remotely operated rover fitted with high-intensity lighting and a filter that separates sediment from the water samples it collects for later analysis in the laboratory. ' +
      'The reef appears to support a wide range of species. ' +
      'Moreover, researchers believe pollution levels in the area remain comparatively low. ' +
      'Subsequently the team plans to return next season with additional equipment. ' +
      'A treaty covering the surrounding waters is under discussion.',
  },
  {
    id: 'demo-adult-nearby',
    sourceName: 'Reuters',
    sourceUrl: 'https://example.com/demo/storm',
    topic: 'World',
    headline: 'Coastal communities move to shelters as major storm approaches: officials warn of severe flooding',
    body:
      'Emergency services have essentially confirmed that thousands of residents were moved inland overnight ahead of a storm that meteorologists describe as the most severe to approach the coastline in more than a decade of continuous record keeping. ' +
      'The disaster response agency opened twelve shelters. ' +
      'An earthquake earlier in the month had already damaged several roads. ' +
      'Furthermore, officials said no injuries have been reported so far.',
  },
  {
    id: 'demo-skip-young',
    sourceName: 'Associated Press',
    sourceUrl: 'https://example.com/demo/border',
    topic: 'World',
    headline: 'Border talks stall as conflict continues into second month | Analysis',
    body:
      'Negotiations between the two governments have stalled, with the conflict along the disputed border now continuing into a second month despite repeated calls for restraint from neighbouring states and several international organisations that have offered to mediate. ' +
      'Officials confirmed that four people were killed and eleven wounded in an attack on a checkpoint. ' +
      'A bomb damaged a bridge on the main road. ' +
      'Aid agencies warn that the war has displaced thousands of families. ' +
      'Talks are expected to resume next week.',
  },
];

function parseAge(argv: string[]): number | undefined {
  const index = argv.indexOf('--age');
  if (index === -1) return undefined;

  const age = Number(argv[index + 1]);
  if (!Number.isInteger(age) || age < 5 || age > 14) {
    throw new Error(`--age must be a whole number from 5 to 14, got '${argv[index + 1]}'.`);
  }
  return age;
}

const RULE = '═'.repeat(78);
const THIN = '─'.repeat(78);

function main(): void {
  const db = openDatabase();

  try {
    const config = loadLocalPipelineConfig(db, parseAge(process.argv.slice(2)));

    console.log(RULE);
    console.log('LOCAL PIPELINE — deny-list guard (§6) + rule-based simplification (§9.2)');
    console.log(RULE);
    console.log(`age target        ${config.ageTarget}  ->  max ${
      config.ageTarget <= 7 ? 14 : config.ageTarget <= 10 ? 20 : 28
    } words per sentence`);
    console.log(`deny-list guard   ${config.denyListEnabled ? 'enabled' : 'DISABLED'}  (${config.denyList.length} terms, loaded from guard_config)`);
    console.log(`deny-list         ${config.denyList.join(', ')}`);

    for (const raw of FIXTURES) {
      const { article, guard } = simplifyLocally(raw, config, {
        id: `demo-out-${raw.id}`,
        now: '2026-09-04T09:00:00.000Z',
      });

      console.log(`\n${RULE}`);
      console.log(`INPUT  ${raw.id}`);
      console.log(RULE);
      console.log(`headline   ${raw.headline}`);
      console.log(`body       ${raw.body.slice(0, 150)}…`);

      console.log(`\n${THIN}`);
      console.log(
        `GUARD      ${guard.matches.length} deny-list ${
          guard.matches.length === 1 ? 'term' : 'terms'
        } matched -> ${article.safety.toUpperCase()}`,
      );
      console.log(`           matched: ${guard.matches.length ? guard.matches.join(', ') : '(none)'}`);
      console.log(THIN);

      console.log(`\nkidHeadline      ${article.kidHeadline}`);
      console.log(`summary          ${article.summary}`);
      console.log(`whatHappened     ${article.whatHappened}`);
      console.log(`whyItMatters     ${article.whyItMatters}`);
      console.log(`thinkAbout       ${article.thinkAbout}`);
      console.log(`vocab            ${article.vocab.map((v) => v.word).join(', ')}`);
      for (const entry of article.vocab) {
        console.log(`                   ${entry.word} — ${entry.definition}`);
      }
      console.log(`safety           ${article.safety}`);
      console.log(`feelingNote      ${article.feelingNote ?? '(none — story is calm)'}`);
      console.log(`contentWarnings  ${article.contentWarnings?.join(', ') ?? '(none)'}`);
      console.log(`category         ${article.category}`);
      console.log(`ageTarget        ${article.ageTarget}`);
      console.log(`readingMinutes   ${article.readingMinutes}`);
      console.log(`status           ${article.status}`);
      console.log(`editedByHuman    ${article.editedByHuman}`);
      console.log(`publishedAt      ${article.publishedAt ?? 'null'}`);

      const longest = article.whatHappened
        .split(/(?<=[.!?])\s+/)
        .reduce((max, s) => Math.max(max, s.split(/\s+/).filter(Boolean).length), 0);
      const limit = config.ageTarget <= 7 ? 14 : config.ageTarget <= 10 ? 20 : 28;
      console.log(
        `\n[check] longest sentence in whatHappened: ${longest} words (limit ${limit}) ${
          longest <= limit ? 'OK' : 'OVER LIMIT'
        }`,
      );
      const leftovers = ['actually', 'essentially', 'moreover', 'furthermore', 'subsequently']
        .filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(article.whatHappened));
      console.log(
        `[check] complex words remaining: ${leftovers.length ? leftovers.join(', ') : 'none'}`,
      );
    }

    console.log(`\n${RULE}`);
    console.log('Nothing was written to the database.');
    console.log(RULE);
  } finally {
    db.close();
  }
}

main();
