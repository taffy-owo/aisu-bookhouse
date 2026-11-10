import { describe, expect, it } from 'vitest';
import { getContentScrollEnd, getContentScrollRatio } from './readerScrollMetrics';

describe('chapter content scroll metrics', () => {
  it('excludes footer navigation and blank padding from the reading endpoint', () => {
    expect(getContentScrollEnd(1400, 900, 1000, 800)).toBe(1100);
    expect(getContentScrollEnd(1400, 1100, 800, 800)).toBe(1100);
    expect(getContentScrollRatio(1100, 1100)).toBe(1);
  });

  it('does not mark unfinished body content as complete', () => {
    expect(getContentScrollRatio(900, 1100)).toBeCloseTo(900 / 1100);
    expect(getContentScrollRatio(1098, 1100)).toBeLessThan(1);
  });

  it('treats subpixel scroll rounding at the chapter end as complete', () => {
    expect(getContentScrollRatio(1099.5, 1100)).toBe(1);
    expect(getContentScrollRatio(1100.5, 1100)).toBe(1);
  });

  it('handles short chapters that fit without scrollable content', () => {
    expect(getContentScrollEnd(100, 0, 500, 800)).toBe(0);
    expect(getContentScrollRatio(0, 0)).toBe(1);
  });

  it('clamps the endpoint and progress during overscroll', () => {
    expect(getContentScrollEnd(1400, 900, 2000, 800)).toBe(1400);
    expect(getContentScrollRatio(-20, 1000)).toBe(0);
  });
});
