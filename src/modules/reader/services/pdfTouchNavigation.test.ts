import { describe, expect, it } from 'vitest';
import { getPdfScreenStep, isPdfPageEndVisible } from './pdfTouchNavigation';
import { getPdfProgressPercent } from './pdfReaderLayout';

describe('PDF reading screens', () => {
  it('retains two lines and reaches both ends without skipping a long reflow page', () => {
    let top = 0;
    const positions = [top];
    while (top < 2400) {
      top = getPdfScreenStep(top, 3200, 800, 1, 36);
      positions.push(top);
    }
    expect(positions).toEqual([0, 728, 1456, 2184, 2400]);
    expect(getPdfScreenStep(top, 3200, 800, -1, 36)).toBe(1672);
    expect(getPdfScreenStep(20, 3200, 800, -1)).toBe(0);
  });
  it('clamps overscroll and short pages and works in a short landscape viewport', () => {
    expect(getPdfScreenStep(-120, 200, 600, 1)).toBe(0);
    expect(getPdfScreenStep(4000, 3200, 800, -1)).toBe(1664);
    expect(getPdfScreenStep(0, 1000, 100, 1, 60)).toBe(50);
  });
  it('requires the actual end to be visible, allowing fractional layout rounding', () => {
    expect(isPdfPageEndVisible(2500, 800)).toBe(false);
    expect(isPdfPageEndVisible(802, 800)).toBe(true);
    expect(isPdfPageEndVisible(803, 800)).toBe(false);
    expect(isPdfPageEndVisible(NaN, 800)).toBe(false);
    expect(getPdfProgressPercent(2, 2, false)).toBe(99);
    expect(getPdfProgressPercent(2, 2, true)).toBe(100);
    expect(getPdfProgressPercent(1, 1, false)).toBe(99);
    expect(getPdfProgressPercent(1, 1, true)).toBe(100);
  });
});
