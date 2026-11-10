import { getContentScrollRatio, getReaderContentScrollEnd } from './readerScrollMetrics';
import { captureReaderSourcePosition, getReaderSourcePositionTop } from './readerSourcePosition';

export interface ReaderViewportAnchor {
  blockIndex: number;
  blockText: string;
  offsetRatio: number;
  viewportOffset: number;
  boundary?: 'start' | 'end';
  sourceOffset?: number;
  sourceViewportOffset?: number;
  sourceSignature?: string;
  sourceContext?: { before: string; after: string };
}

function getBlocks(shell: HTMLElement): ArrayLike<HTMLElement> {
  return (shell.querySelector('.reader-body-text')?.children ?? []) as ArrayLike<HTMLElement>;
}

/** A paragraph anchor survives reflow and moving between document/container scroll. */
export function captureReaderViewportAnchor(shell: HTMLElement, scrollElement: HTMLElement, previousBlockIndex = 0, captureSource = false): ReaderViewportAnchor | null {
  const blocks = getBlocks(shell);
  if (!blocks.length) return null;
  const viewportTop = scrollElement === document.scrollingElement ? 0 : Math.max(0, scrollElement.getBoundingClientRect().top);
  const readingLine = viewportTop + 80;
  // A reader sheet fixes the body; scrollTop temporarily becomes zero even
  // though the paragraph's screen position still represents mid-chapter.
  const documentIsLocked = scrollElement === document.scrollingElement && document.body.style.position === 'fixed';
  const currentTop = documentIsLocked ? Math.max(0, -(Number.parseFloat(document.body.style.top) || 0)) : scrollElement.scrollTop;
  const maxScrollTop = getReaderContentScrollEnd(scrollElement);
  const boundary = currentTop <= 1 ? 'start' : maxScrollTop > 0 && currentTop >= maxScrollTop - 1 ? 'end' : undefined;
  // Reuse the current paragraph while it remains visible. Large scrollbar
  // jumps search document order without measuring every intervening block.
  let firstVisible = Math.max(0, Math.min(blocks.length - 1, previousBlockIndex));
  let low = 0;
  let high = blocks.length;
  if (blocks[firstVisible].getBoundingClientRect().bottom <= readingLine) low = firstVisible + 1;
  else if (firstVisible === 0 || blocks[firstVisible - 1].getBoundingClientRect().bottom <= readingLine) low = high = firstVisible;
  else high = firstVisible;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (blocks[middle].getBoundingClientRect().bottom <= readingLine) low = middle + 1;
    else high = middle;
  }
  firstVisible = low;
  if (firstVisible === blocks.length) firstVisible = -1;
  const blockIndex = firstVisible < 0 && boundary ? blocks.length - 1 : firstVisible;
  if (blockIndex < 0) return null;
  const bounds = blocks[blockIndex].getBoundingClientRect();
  return {
    ...(captureSource ? captureReaderSourcePosition(blocks[blockIndex], readingLine, viewportTop) : null),
    blockIndex,
    blockText: blocks[blockIndex].textContent?.trim().slice(0, 64) ?? '',
    offsetRatio: Math.max(0, Math.min(1, (readingLine - bounds.top) / Math.max(1, bounds.height))),
    viewportOffset: Math.max(readingLine, bounds.top) - viewportTop,
    boundary,
  };
}

export function restoreReaderViewportAnchor(shell: HTMLElement, scrollElement: HTMLElement, anchor: ReaderViewportAnchor): number {
  const maxScrollTop = getReaderContentScrollEnd(scrollElement);
  const blocks = Array.from(getBlocks(shell));
  const sourceTop = anchor.sourceOffset === undefined ? null : getReaderSourcePositionTop(blocks, anchor.sourceOffset);
  const indexed = blocks[anchor.blockIndex];
  // Repeated short dialogue is common. Prefer its original index, then the
  // nearest matching paragraph when a layout change regrouped the blocks.
  const matches = (candidate: HTMLElement) => Boolean(anchor.blockText && candidate.textContent?.trim().startsWith(anchor.blockText));
  const block = indexed && (!anchor.blockText || matches(indexed)) ? indexed
    : blocks.map((candidate, index) => ({ candidate, distance: Math.abs(index - anchor.blockIndex) }))
      .filter(({ candidate }) => matches(candidate)).sort((a, b) => a.distance - b.distance)[0]?.candidate ?? indexed;
  if (anchor.boundary === 'start') scrollElement.scrollTop = 0;
  else if (anchor.boundary === 'end') scrollElement.scrollTop = maxScrollTop;
  else if (sourceTop !== null && anchor.sourceViewportOffset !== undefined) {
    const viewportTop = scrollElement === document.scrollingElement ? 0 : Math.max(0, scrollElement.getBoundingClientRect().top);
    scrollElement.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollElement.scrollTop + sourceTop - viewportTop - anchor.sourceViewportOffset));
  } else if (block) {
    const viewportTop = scrollElement === document.scrollingElement ? 0 : Math.max(0, scrollElement.getBoundingClientRect().top);
    const bounds = block.getBoundingClientRect();
    const delta = bounds.top + bounds.height * anchor.offsetRatio - viewportTop - anchor.viewportOffset;
    scrollElement.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollElement.scrollTop + delta));
  }
  return getContentScrollRatio(scrollElement.scrollTop, maxScrollTop);
}
