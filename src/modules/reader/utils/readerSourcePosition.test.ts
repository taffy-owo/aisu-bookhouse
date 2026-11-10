import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureReaderSourcePosition, getReaderSourcePositionTop } from './readerSourcePosition';

type GlyphNode = { length: number; parentElement: { closest: () => boolean }; top: (offset: number) => number };
const text = (length: number, top: (offset: number) => number, annotation = false): GlyphNode => ({
  length, top, parentElement: { closest: () => annotation },
});
function block(start: number, nodes: GlyphNode[]) {
  return {
    dataset: { readerSourceStart: String(start), readerSourceLength: String(nodes.filter(node => !node.parentElement.closest()).reduce((sum, node) => sum + node.length, 0)) },
    querySelector: () => nodes,
  } as unknown as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
  vi.stubGlobal('document', {
    createTreeWalker(nodes: GlyphNode[]) {
      let index = -1;
      return { nextNode: () => nodes[++index], get currentNode() { return nodes[index]; } };
    },
    createRange() {
      let node: GlyphNode;
      let offset = 0;
      return {
        setStart(next: GlyphNode, position: number) { node = next; offset = position; },
        setEnd() {},
        getBoundingClientRect() { const top = node.top(offset); return { top, bottom: top + 10 }; },
      };
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('source text reading position', () => {
  it('excludes ruby annotations when locating the first visible source character', () => {
    const paragraph = block(100, [text(1, () => 0), text(3, () => 0, true), text(3, offset => 20 + offset * 20)]);
    expect(captureReaderSourcePosition(paragraph, 35, 5)).toEqual({ sourceOffset: 102, sourceViewportOffset: 35 });
  });
  it('finds the same source character after paragraphs split, even with repeated dialogue', () => {
    const merged = block(100, [text(2, () => 10), text(2, () => 30)]);
    const anchor = captureReaderSourcePosition(merged, 25, 0)!;
    expect(anchor.sourceOffset).toBe(102);
    const split = [block(100, [text(2, () => 40)]), block(102, [text(2, () => 90)])];
    expect(getReaderSourcePositionTop(split, anchor.sourceOffset)).toBe(90);
    expect(getReaderSourcePositionTop([merged], 102)).toBe(30);
  });
  it('falls back for images, empty source text and offsets outside the new source', () => {
    expect(captureReaderSourcePosition({ dataset: {} } as HTMLElement, 80, 0)).toBeNull();
    expect(captureReaderSourcePosition(block(0, []), 80, 0)).toBeNull();
    expect(getReaderSourcePositionTop([block(0, [text(2, () => 40)])], 2)).toBeNull();
  });
});
