import { describe, expect, it } from 'vitest';
import { formatReadingProgressPercent, normalizeReadingProgress } from './readingProgress';

describe('reading progress display', () => {
  it.each([
    [0, '0%'], [0.01, '<1%'], [0.8, '<1%'], [1, '1%'],
    [43.6, '44%'], [99.49, '99%'], [99.99, '99%'], [100, '100%'],
  ])('formats %s without implying an unread or finished state prematurely', (value, expected) => {
    expect(formatReadingProgressPercent(value)).toBe(expected);
    expect(normalizeReadingProgress(value)).toBe(value);
  });

  it('keeps invalid values out of labels, accessible progress and CSS widths', () => {
    for (const value of [NaN, Infinity, -Infinity, -3]) {
      expect(normalizeReadingProgress(value)).toBe(0);
      expect(formatReadingProgressPercent(value)).toBe('0%');
    }
    expect(normalizeReadingProgress(120)).toBe(100);
    expect(formatReadingProgressPercent(120)).toBe('100%');
  });
});
