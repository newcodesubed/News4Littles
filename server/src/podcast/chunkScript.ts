/**
 * An episode split into pieces the voice will accept (spec §7).
 *
 * TTS_MAX_CHARS caps one request, and a whole episode is several times that.
 * Pieces break at sentence ends so the joins fall where a speaker would pause
 * anyway; a single sentence longer than a piece breaks at its last space.
 * Whitespace is collapsed, which is what the voice would do with it too.
 */

/** A run of text up to and including its closing punctuation and quote. */
const SENTENCE = /[^.!?…]*(?:[.!?…]+["'”’)]*\s*|$)/g;

export function chunkScript(script: string, maxChars: number): string[] {
  const text = script.replace(/\s+/g, ' ').trim();
  const sentences = (text.match(SENTENCE) ?? []).filter((sentence) => sentence !== '');

  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (let sentence of sentences) {
    while (sentence.length > maxChars) {
      flush();
      const space = sentence.lastIndexOf(' ', maxChars);
      const cut = space > 0 ? space : maxChars;
      chunks.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trimStart();
    }
    if (current.length + sentence.length > maxChars) flush();
    current += sentence;
  }
  flush();

  return chunks;
}
