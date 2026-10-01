/**
 * Minimal BBC article pages in both live shapes (see ingestion/bbcArticle.ts),
 * built from the same block model the real pages use. Tiny on purpose: a real
 * page is 400 KB of navigation and adverts around the same JSON.
 */

const paragraph = (text: string) => ({
  type: 'paragraph',
  model: { text, blocks: [{ type: 'fragment', model: { text, attributes: [] } }] },
});

/** A block whose paragraphs sit one level down, as headline/subheadline/caption do. */
const nested = (type: string, text: string) => ({
  type,
  model: { blocks: [{ type: 'text', model: { blocks: [paragraph(text)] } }] },
});

export const block = {
  headline: (text: string) => nested('headline', text),
  text: (...texts: string[]) => ({ type: 'text', model: { blocks: texts.map(paragraph) } }),
  subheadline: (text: string) => nested('subheadline', text),
  image: (caption: string) => ({
    type: 'image',
    model: { blocks: [nested('caption', caption)] },
  }),
  byline: (name: string) => ({
    type: 'byline',
    model: { blocks: [{ type: 'contributor', model: { blocks: [nested('name', name)] } }] },
  }),
  links: (text: string) => nested('links', text),
};

/** A full article with every kind of block the extractor must keep or drop. */
export const ARTICLE_BLOCKS = [
  block.headline('The adult headline'),
  block.byline('A Reporter'),
  block.text('First paragraph.', 'Second paragraph.'),
  block.image('A photo caption'),
  block.subheadline('A subheading'),
  block.text('Third paragraph.'),
  block.links('Related: another story'),
];

/** What ARTICLE_BLOCKS should extract to. */
export const ARTICLE_TEXT =
  'First paragraph.\n\nSecond paragraph.\n\nA subheading\n\nThird paragraph.';

/** bbc.co.uk and Sport: JSON inside a JS string literal. */
export function initialDataPage(blocks: unknown[]): string {
  const data = {
    data: {
      'global-navigation?country=gb': { data: { links: [] } },
      'article?service=news&urn=abc': { data: { content: { model: { blocks } } } },
    },
  };
  return `<!doctype html><html><body><script>window.__INITIAL_DATA__=${
    JSON.stringify(JSON.stringify(data))
  };</script></body></html>`;
}

/** bbc.com news: Next.js page props. */
export function nextDataPage(contents: unknown[]): string {
  const data = { props: { pageProps: { page: { '@"news","articles","abc",': { contents } } } } };
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${
    JSON.stringify(data)
  }</script></body></html>`;
}
