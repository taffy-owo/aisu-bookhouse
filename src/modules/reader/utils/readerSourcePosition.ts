/** Locate original text without counting ruby readings or generated translations. */
function sourceCharacters(block: HTMLElement) {
  const source = block.querySelector('p, h1, h2, h3, h4, h5, h6');
  if (!source) return null;
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let length = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('rt, rp')) continue;
    const end = length + node.length;
    if (end > length) nodes.push({ node, start: length, end });
    length = end;
  }
  if (!length) return null;
  const range = document.createRange();
  return {
    length,
    rect(offset: number) {
      const position = Math.max(0, Math.min(length - 1, offset));
      const entry = nodes.find((entry) => entry.end > position)!;
      range.setStart(entry.node, position - entry.start);
      range.setEnd(entry.node, position - entry.start + 1);
      return range.getBoundingClientRect();
    },
  };
}

export function captureReaderSourcePosition(block: HTMLElement, readingLine: number, viewportTop: number) {
  const start = block.dataset?.readerSourceStart;
  if (start === undefined) return null;
  const characters = sourceCharacters(block);
  if (!characters) return null;
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (characters.rect(middle).bottom > readingLine) high = middle;
    else low = middle + 1;
  }
  return { sourceOffset: Number(start) + low, sourceViewportOffset: characters.rect(low).top - viewportTop };
}

export function getReaderSourcePositionTop(blocks: HTMLElement[], offset: number): number | null {
  const block = blocks.find((candidate) => {
    const start = candidate.dataset?.readerSourceStart;
    return start !== undefined && offset >= Number(start) && offset < Number(start) + Number(candidate.dataset.readerSourceLength);
  });
  if (!block) return null;
  return sourceCharacters(block)?.rect(offset - Number(block.dataset.readerSourceStart)).top ?? null;
}
