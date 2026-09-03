/**
 * Hand-written sample articles for UI development. PRD §3 (tone), §8.3 (shape).
 *
 * These are PLACEHOLDERS, not real news — invented stories with no real people,
 * places or dates, written in the product's voice so the UI has realistic
 * material. Real content arrives via the scraper (§5.2) or editor portal (§4.3).
 *
 * Deliberate variety so filtering (§4.2) has something to bite on:
 *   safety     — calm, adult-nearby, skip-young
 *   category   — Environment, Science, World, Sports, Good News
 *   status     — pending_review, published, rejected
 *   ageTarget  — spread across 6-13
 *
 * Every kid article needs a raw_articles parent (originalId is a NOT NULL FK),
 * so each sample below carries the "original" it was rewritten from.
 *
 * Re-running REPLACES these rows (they share the 'sample-' id prefix) so you
 * always get the same known set back. Rows you create yourself are untouched.
 */
import { fileURLToPath } from 'node:url';
import { DATABASE_PATH, openDatabase } from './connection.js';
import { seed as seedReferenceData } from './seed.js';

const SAMPLE_ID_PREFIX = 'sample-';

interface SampleArticle {
  key: string;
  original: { headline: string; body: string; sourceId: string; sourceName: string; sourceUrl: string; url: string };
  kid: {
    ageTarget: number;
    kidHeadline: string;
    summary: string;
    whatHappened: string;
    whyItMatters: string;
    vocab: { word: string; definition: string }[];
    thinkAbout: string;
    feelingNote: string | null;
    safety: 'calm' | 'adult-nearby' | 'skip-young';
    contentWarnings: string[] | null;
    category: string;
    readingMinutes: number;
    status: 'pending_review' | 'published' | 'rejected';
    rejectReason: string | null;
    editedByHuman: boolean;
    daysAgo: number;
  };
}

const BBC = { sourceId: 'bbc', sourceName: 'BBC News', sourceUrl: 'https://www.bbc.co.uk/news' };

const SAMPLES: SampleArticle[] = [
  {
    key: 'coral',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/coral-garden',
      headline: 'Researchers document previously uncharted deep-water coral formation',
      body: 'A survey team using a remotely operated vehicle has documented an extensive cold-water coral formation at depth. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 6,
      kidHeadline: 'A secret coral garden was found deep in the sea!',
      summary: 'Scientists found a huge coral garden hiding far below the waves.',
      whatHappened:
        'A team sent a small robot deep under the ocean. The robot has a camera and bright lights. It found corals growing in the cold, dark water. Nobody had seen this place before.',
      whyItMatters:
        'Lots of sea animals live in coral. Finding a new coral garden means there is a new home to look after. It also shows how much of the ocean we still have not seen.',
      vocab: [
        { word: 'coral', definition: 'A tiny sea animal that builds hard, rocky homes underwater.' },
        { word: 'robot', definition: 'A machine that can do a job on its own.' },
      ],
      thinkAbout: 'If you could send a robot anywhere, where would you send it?',
      feelingNote: null,
      safety: 'calm',
      contentWarnings: null,
      category: 'Environment',
      readingMinutes: 3,
      status: 'published',
      rejectReason: null,
      editedByHuman: false,
      daysAgo: 0,
    },
  },
  {
    key: 'rover',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/mars-rover-mapping',
      headline: 'Rover completes mapping survey of crater floor',
      body: 'The rover has completed a mapping traverse across the crater floor. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 8,
      kidHeadline: 'A little robot is drawing maps of Mars',
      summary: 'A rover on Mars has finished mapping the floor of a giant crater.',
      whatHappened:
        'A rover is a robot with wheels that drives around on Mars. This one spent months rolling across a huge crater. It took pictures the whole way. Scientists on Earth turned those pictures into a map.',
      whyItMatters:
        'Nobody has ever walked on Mars, so robots go first and send back what they see. Good maps help scientists pick where to look next. One day they might help people land there.',
      vocab: [
        { word: 'rover', definition: 'A robot with wheels that explores another planet.' },
        { word: 'crater', definition: 'A big bowl-shaped dent made when a rock crashes into a planet.' },
      ],
      thinkAbout: 'What would you want a rover to look for on Mars?',
      feelingNote: null,
      safety: 'calm',
      contentWarnings: null,
      category: 'Science',
      readingMinutes: 4,
      status: 'published',
      rejectReason: null,
      editedByHuman: false,
      daysAgo: 1,
    },
  },
  {
    key: 'trees',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/school-tree-planting',
      headline: 'School programme reports ten thousand saplings planted',
      body: 'A regional school programme has reported the planting of ten thousand saplings. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 7,
      kidHeadline: 'Kids planted ten thousand trees on the hills',
      summary: 'Schoolchildren spent a season planting trees and they are already growing.',
      whatHappened:
        'Children from lots of schools worked together. Each class took a patch of hillside. They dug holes, put in young trees, and watered them. Together they planted ten thousand.',
      whyItMatters:
        'Trees hold the soil so the hills do not slide away when it rains. They also make shade and clean air. These children will be grown up when their trees are tall.',
      vocab: [
        { word: 'sapling', definition: 'A very young tree.' },
        { word: 'soil', definition: 'The dirt that plants grow in.' },
      ],
      thinkAbout: 'If you planted a tree today, who do you think would sit under it?',
      feelingNote: null,
      safety: 'calm',
      contentWarnings: null,
      category: 'Good News',
      readingMinutes: 3,
      status: 'published',
      rejectReason: null,
      editedByHuman: true,
      daysAgo: 2,
    },
  },
  {
    key: 'swimmer',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/junior-swimming-record',
      headline: 'Fifteen-year-old sets national junior swimming record',
      body: 'A fifteen-year-old swimmer has set a new national junior record. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 9,
      kidHeadline: 'A fifteen-year-old swam faster than anyone her age',
      summary: 'A young swimmer broke a record that had stood for eleven years.',
      whatHappened:
        'She has been training before school since she was seven. At the big meet she swam two lengths faster than any swimmer her age had before. The old record had lasted eleven years.',
      whyItMatters:
        'Records show what people can do when they keep practising. Her coach says the training mattered more than the race. Other young swimmers now have something new to aim at.',
      vocab: [
        { word: 'record', definition: 'The best that anyone has ever done at something.' },
        { word: 'coach', definition: 'A person who teaches you how to get better at a sport.' },
      ],
      thinkAbout: 'What is something you have got better at by practising?',
      feelingNote: null,
      safety: 'calm',
      contentWarnings: null,
      category: 'Sports',
      readingMinutes: 3,
      status: 'pending_review',
      rejectReason: null,
      editedByHuman: false,
      daysAgo: 0,
    },
  },
  {
    key: 'bread',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/drought-resistant-grain',
      headline: 'Trial of drought-resistant grain variety reports early results',
      body: 'A field trial of a drought-resistant grain variety has reported early results. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 11,
      kidHeadline: 'A new kind of grain can grow with less water',
      summary: 'Farmers are testing a grain that keeps growing when the rain does not come.',
      whatHappened:
        'Scientists spent years crossing different kinds of wheat. They were looking for plants that survive dry weather. In the first field tests the new grain kept growing when the older kind dried out.',
      whyItMatters:
        'Bread and noodles are made from grain, so a lot of people depend on it. In places where rain is getting less reliable, a plant that needs less water could mean more food.',
      vocab: [
        { word: 'grain', definition: 'The seed of a plant like wheat or rice, used to make food.' },
        { word: 'drought', definition: 'A long time with much less rain than usual.' },
      ],
      thinkAbout: 'What foods in your kitchen are made from grain?',
      feelingNote: null,
      safety: 'calm',
      contentWarnings: null,
      category: 'Science',
      readingMinutes: 4,
      status: 'rejected',
      rejectReason: 'Reads more like an explainer than news — hold until there are actual results to report.',
      editedByHuman: false,
      daysAgo: 3,
    },
  },
  {
    key: 'storm',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/coastal-storm-shelters',
      headline: 'Coastal communities move to shelters ahead of severe storm',
      body: 'Coastal communities have moved to temporary shelters ahead of a severe storm. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 10,
      kidHeadline: 'Families moved somewhere safe before a big storm',
      summary: 'A strong storm was coming, so families near the coast went to shelters.',
      whatHappened:
        'Weather scientists saw the storm coming days ahead. People near the sea packed bags and went to strong buildings further inland. Schools and halls were opened up for them to stay in.',
      whyItMatters:
        'Knowing about a storm early gives people time to get somewhere safe. That warning is why everyone got out in time. Many will go home once the weather calms down.',
      vocab: [
        { word: 'shelter', definition: 'A safe place to stay when it is not safe at home.' },
        { word: 'forecast', definition: 'A guess about what the weather will do next.' },
      ],
      thinkAbout: 'What would you put in a bag if you had to leave home for a few days?',
      feelingNote:
        'Storms can sound scary, but people knew this one was coming and got somewhere safe in time. Grown-ups plan for this, and helpers are already on the way.',
      safety: 'adult-nearby',
      contentWarnings: ['severe weather', 'families leaving home'],
      category: 'World',
      readingMinutes: 4,
      status: 'pending_review',
      rejectReason: null,
      editedByHuman: false,
      daysAgo: 1,
    },
  },
  {
    key: 'ice',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/polar-ice-measurements',
      headline: 'Satellite measurements indicate accelerating polar ice loss',
      body: 'Satellite measurements indicate an accelerating rate of polar ice loss. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 12,
      kidHeadline: 'The ice at the top of the world is melting faster',
      summary: 'Satellites show that polar ice is disappearing more quickly than before.',
      whatHappened:
        'Satellites have been measuring the thickness of polar ice for decades. The newest measurements show it is thinning faster than it was twenty years ago. Scientists say warmer water underneath is part of the reason.',
      whyItMatters:
        'When ice on land melts, that water ends up in the sea, and the sea slowly rises. Animals like polar bears also hunt from the ice. Scientists are watching closely so that people can plan.',
      vocab: [
        { word: 'satellite', definition: 'A machine that circles the Earth and takes measurements from space.' },
        { word: 'polar', definition: 'To do with the very cold places at the top and bottom of the Earth.' },
      ],
      thinkAbout: 'Why do you think scientists measure the same thing over and over for many years?',
      feelingNote:
        'This is a big problem, and it is a slow one. Lots of clever people are working on it right now, and there are real things families can do to help.',
      safety: 'adult-nearby',
      contentWarnings: ['climate change'],
      category: 'Environment',
      readingMinutes: 5,
      status: 'published',
      rejectReason: null,
      editedByHuman: true,
      daysAgo: 4,
    },
  },
  {
    key: 'border',
    original: {
      ...BBC,
      url: 'https://example.com/placeholder/border-talks-stall',
      headline: 'Talks stall as border dispute continues into second month',
      body: 'Negotiations have stalled as a border dispute continues. Placeholder text for local development only.',
    },
    kid: {
      ageTarget: 13,
      kidHeadline: 'Two countries are still arguing over their border',
      summary: 'Talks between two countries have paused, and the disagreement continues.',
      whatHappened:
        'Two countries disagree about where the line between them should be. They sent people to talk about it, but the talks stopped without an answer. Families who live near the line have moved away for now.',
      whyItMatters:
        'Borders decide which country a place belongs to, which affects schools, hospitals and jobs. Other countries have offered to help the two sides keep talking. Most disagreements like this do end at a table.',
      vocab: [
        { word: 'border', definition: 'The line where one country ends and another begins.' },
        { word: 'negotiate', definition: 'To talk with someone until you both agree on something.' },
      ],
      thinkAbout: 'What helps two people settle an argument fairly?',
      feelingNote:
        'News about countries arguing can feel unsettling. This is happening a long way away, and people whose whole job is helping countries talk are working on it.',
      safety: 'skip-young',
      contentWarnings: ['armed conflict', 'people leaving their homes'],
      category: 'World',
      readingMinutes: 5,
      status: 'pending_review',
      rejectReason: null,
      editedByHuman: false,
      daysAgo: 2,
    },
  },
];

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

export function seedArticles(path: string = DATABASE_PATH): { rawArticles: number; kidArticles: number } {
  // Sample articles reference sources.id, so the reference data must exist first.
  seedReferenceData(path);

  const db = openDatabase(path);

  const run = db.transaction(() => {
    // Children first — originalId is ON DELETE RESTRICT.
    db.prepare(`DELETE FROM kid_articles WHERE id LIKE ?`).run(`${SAMPLE_ID_PREFIX}%`);
    db.prepare(`DELETE FROM raw_articles WHERE id LIKE ?`).run(`${SAMPLE_ID_PREFIX}%`);

    const insertRaw = db.prepare(
      `INSERT INTO raw_articles
         (id, sourceId, sourceName, sourceUrl, url, headline, body, topic, publishedAt, fetchedAt)
       VALUES (@id, @sourceId, @sourceName, @sourceUrl, @url, @headline, @body, @topic, @publishedAt, @fetchedAt)`,
    );

    const insertKid = db.prepare(
      `INSERT INTO kid_articles
         (id, originalId, ageTarget, kidHeadline, summary, whatHappened, whyItMatters, vocab,
          thinkAbout, feelingNote, safety, contentWarnings, category, readingMinutes,
          sourceName, sourceUrl, status, rejectReason, editedByHuman, createdAt, publishedAt)
       VALUES
         (@id, @originalId, @ageTarget, @kidHeadline, @summary, @whatHappened, @whyItMatters, @vocab,
          @thinkAbout, @feelingNote, @safety, @contentWarnings, @category, @readingMinutes,
          @sourceName, @sourceUrl, @status, @rejectReason, @editedByHuman, @createdAt, @publishedAt)`,
    );

    for (const sample of SAMPLES) {
      const rawId = `${SAMPLE_ID_PREFIX}raw-${sample.key}`;
      const kidId = `${SAMPLE_ID_PREFIX}${sample.key}`;
      const createdAt = isoDaysAgo(sample.kid.daysAgo);

      insertRaw.run({
        id: rawId,
        ...sample.original,
        topic: sample.kid.category,
        publishedAt: createdAt,
        fetchedAt: createdAt,
      });

      insertKid.run({
        id: kidId,
        originalId: rawId,
        ageTarget: sample.kid.ageTarget,
        kidHeadline: sample.kid.kidHeadline,
        summary: sample.kid.summary,
        whatHappened: sample.kid.whatHappened,
        whyItMatters: sample.kid.whyItMatters,
        vocab: JSON.stringify(sample.kid.vocab),
        thinkAbout: sample.kid.thinkAbout,
        feelingNote: sample.kid.feelingNote,
        safety: sample.kid.safety,
        contentWarnings: sample.kid.contentWarnings === null
          ? null
          : JSON.stringify(sample.kid.contentWarnings),
        category: sample.kid.category,
        readingMinutes: sample.kid.readingMinutes,
        sourceName: sample.original.sourceName,
        sourceUrl: sample.original.url,
        status: sample.kid.status,
        rejectReason: sample.kid.rejectReason,
        editedByHuman: sample.kid.editedByHuman ? 1 : 0,
        createdAt,
        // Schema CHECK: status 'published' requires publishedAt.
        publishedAt: sample.kid.status === 'published' ? createdAt : null,
      });
    }
  });

  try {
    run();
    return { rawArticles: SAMPLES.length, kidArticles: SAMPLES.length };
  } finally {
    db.close();
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const { rawArticles, kidArticles } = seedArticles();
  const db = openDatabase();
  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n FROM kid_articles GROUP BY status ORDER BY status`)
    .all() as { status: string; n: number }[];
  const bySafety = db
    .prepare(`SELECT safety, COUNT(*) AS n FROM kid_articles GROUP BY safety ORDER BY safety`)
    .all() as { safety: string; n: number }[];
  db.close();

  console.log(`Seeded ${kidArticles} sample articles (+${rawArticles} raw parents) into ${DATABASE_PATH}`);
  console.log(`  by status  ${byStatus.map((r) => `${r.status}=${r.n}`).join('  ')}`);
  console.log(`  by safety  ${bySafety.map((r) => `${r.safety}=${r.n}`).join('  ')}`);
  console.log(`\nSample rows use the '${SAMPLE_ID_PREFIX}' id prefix and are replaced on every run.`);
}
