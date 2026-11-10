export type PdfPageAnchor = {
  pageNumber: number;
  relativeX: number;
  relativeY: number;
  viewportX: number;
  viewportY: number;
  overflowY: number;
  followViewport?: boolean;
  textBlock?: { index: number; relativeY: number };
};

/** Keep an unfinished explicit jump at the destination after a layout/document swap. */
export function createPdfPageStartAnchor(scroller: HTMLElement, pageNumber: number): PdfPageAnchor {
  return {
    pageNumber, relativeX: 0.5, relativeY: 0,
    viewportX: scroller.clientWidth * 0.5, viewportY: 0, overflowY: 0,
  };
}

export function readPdfPageAnchor(scroller: HTMLElement, frame: HTMLElement, pageNumber: number): PdfPageAnchor | null {
  if (!scroller.clientWidth || !scroller.clientHeight) return null;
  const page = frame.querySelector('.pdf-canvas-page') ?? frame;
  const bounds = page.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  const viewportX = scroller.clientWidth * 0.5;
  const viewportY = Math.min(scroller.clientHeight * 0.32, 240);
  const readingLine = viewport.top + viewportY;
  const offsetY = readingLine - bounds.top;
  const paragraphs = Array.from(frame.querySelectorAll('.pdf-reflow-text p'));
  const index = paragraphs.findIndex((paragraph) => {
    const rect = paragraph.getBoundingClientRect();
    return rect.top <= readingLine && rect.bottom > readingLine;
  });
  const block = paragraphs[index]?.getBoundingClientRect();
  return {
    pageNumber,
    relativeX: Math.min(1, Math.max(0, (viewport.left + viewportX - bounds.left) / Math.max(1, bounds.width))),
    relativeY: Math.min(1, Math.max(0, offsetY / Math.max(1, bounds.height))),
    // A selected page can be only partly visible during navigation. Keep its
    // distance from the reading line instead of pulling its edge into view.
    overflowY: offsetY < 0 ? offsetY : Math.max(0, offsetY - bounds.height),
    viewportX, viewportY,
    textBlock: block ? { index, relativeY: (readingLine - block.top) / Math.max(1, block.height) } : undefined,
  };
}

export function restorePdfPageAnchor(scroller: HTMLElement, frame: HTMLElement, anchor: PdfPageAnchor) {
  const page = frame.querySelector('.pdf-canvas-page') ?? frame;
  const bounds = page.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  const viewportX = anchor.followViewport ? scroller.clientWidth * 0.5 : anchor.viewportX;
  const viewportY = anchor.followViewport ? Math.min(scroller.clientHeight * 0.32, 240) : anchor.viewportY;
  const block = anchor.textBlock && frame.querySelectorAll('.pdf-reflow-text p')[anchor.textBlock.index]?.getBoundingClientRect();
  const y = block && anchor.textBlock ? block.top + block.height * anchor.textBlock.relativeY : bounds.top + bounds.height * anchor.relativeY + anchor.overflowY;
  scroller.scrollLeft += bounds.left + bounds.width * anchor.relativeX - (viewport.left + viewportX);
  scroller.scrollTop += y - (viewport.top + viewportY);
}
