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
