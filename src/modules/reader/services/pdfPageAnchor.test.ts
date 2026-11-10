import { describe, expect, it } from 'vitest';
import { createPdfPageStartAnchor, readPdfPageAnchor, restorePdfPageAnchor } from './pdfPageAnchor';

function fixture(top: number, height = 1000, paragraphs: Array<{ top: number; height: number }> = []) {
  const bounds = { top, height, left: 0, width: 600 };
  const frame = { getBoundingClientRect: () => bounds, querySelector: () => null, querySelectorAll: () => paragraphs.map((p) => ({ getBoundingClientRect: () => ({ ...p, bottom: p.top + p.height }) })) } as unknown as HTMLElement;
  const scroller = { clientHeight: 800, clientWidth: 600, scrollTop: 1000, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, left: 0 }) } as unknown as HTMLElement;
  return { scroller, frame, bounds, paragraphs };
}
describe('PDF reading line anchors', () => {
  it.each([500, -400])('finishes a requested jump after replacing a page still at screen coordinate %s', (top) => {
    const { scroller, frame, bounds } = fixture(top);
    const anchor = createPdfPageStartAnchor(scroller, 2);
    // A replacement PDF or a width change can alter the destination's size.
    bounds.height = 1600;
    restorePdfPageAnchor(scroller, frame, anchor);
    expect(scroller.scrollTop).toBe(1000 + top);
  });
  it.each([500, -1200])('keeps a selected page outside the reading line at top %s without snapping its edge', (top) => {
    const { scroller, frame, bounds } = fixture(top);
    const anchor = readPdfPageAnchor(scroller, frame, 2)!;
    restorePdfPageAnchor(scroller, frame, anchor);
    expect(scroller.scrollTop).toBe(1000);
    if (top > 0) {
      bounds.height = 2000;
      restorePdfPageAnchor(scroller, frame, { ...anchor, followViewport: true });
      expect(scroller.scrollTop).toBe(1000);
    }
  });
  it('follows the same text paragraph when typography changes its geometry', () => {
    const paragraphs = [{ top: 230, height: 40 }];
    const { scroller, frame } = fixture(-100, 1000, paragraphs);
    const anchor = readPdfPageAnchor(scroller, frame, 1)!;
    expect(anchor.textBlock).toEqual({ index: 0, relativeY: 0.25 });
    paragraphs[0] = { top: 180, height: 80 };
    restorePdfPageAnchor(scroller, frame, anchor);
    expect(scroller.scrollTop).toBe(960);
  });
});
