import { describe, expect, it } from 'vitest';
import { decodeChapterScrollRatio, encodeChapterScrollRatio, getChapterProgressPercent } from './chapterScrollPosition';

describe('chapterScrollPosition', () => {
  it('encodes and decodes chapter scroll ratios', () => {
    expect(decodeChapterScrollRatio(encodeChapterScrollRatio(0.45678))).toBe(0.45678);
  });

  it('retains sub-line precision for very long chapters', () => {
    const scrollHeight = 4_000_000;
    const scrollTop = 1_370_513.375;
    const restored = decodeChapterScrollRatio(encodeChapterScrollRatio(scrollTop / scrollHeight));
    expect(restored).not.toBeNull();
    expect(Math.abs(restored! * scrollHeight - scrollTop)).toBeLessThan(0.001);
  });

  it('does not round near-start or near-end positions into endpoints', () => {
    expect(decodeChapterScrollRatio(encodeChapterScrollRatio(0.00001))).toBe(0.00001);
    expect(decodeChapterScrollRatio(encodeChapterScrollRatio(0.99999))).toBe(0.99999);
  });

  it('reads existing fixed-decimal positions and clamps out-of-range ratios', () => {
    expect(decodeChapterScrollRatio('aisu-scroll:0.4568')).toBe(0.4568);
    expect(decodeChapterScrollRatio(encodeChapterScrollRatio(-0.2))).toBe(0);
    expect(decodeChapterScrollRatio(encodeChapterScrollRatio(1.2))).toBe(1);
  });

  it('rejects unrelated cfi values', () => {
    expect(decodeChapterScrollRatio('epubcfi(/6/2)')).toBeNull();
    expect(decodeChapterScrollRatio(undefined)).toBeNull();
  });

  it('calculates progress inside the current chapter', () => {
    expect(getChapterProgressPercent(2, 10, 0)).toBe(10);
    expect(getChapterProgressPercent(2, 10, 0.5)).toBe(15);
    expect(getChapterProgressPercent(10, 10, 1)).toBe(100);
  });

  it('gives a single-image chapter much less progress than long text chapters', () => {
    const chapterWeights = [5000, 180, 5000];

    expect(getChapterProgressPercent(2, 3, 0, chapterWeights)).toBe(49);
    expect(getChapterProgressPercent(2, 3, 1, chapterWeights)).toBe(51);
    expect(getChapterProgressPercent(3, 3, 1, chapterWeights)).toBe(100);
  });

  it('falls back to equal chapter progress when any weight is missing', () => {
    expect(getChapterProgressPercent(2, 3, 0, [5000, undefined, 5000])).toBe(33);
    expect(getChapterProgressPercent(2, 3, 1, [5000, undefined, 5000])).toBe(67);
  });

  it('keeps rounded sub-percent progress without finishing before the end', () => {
    expect(getChapterProgressPercent(1, 3, 0)).toBe(0);
    expect(getChapterProgressPercent(1, 3, 0.012)).toBe(0);
    expect(getChapterProgressPercent(3, 3, 0.994)).toBe(99);
    expect(getChapterProgressPercent(3, 3, 1)).toBe(100);
  });

  it('does not finish a weighted book before its short final chapter', () => {
    const weights = [100000, 1];
    expect(getChapterProgressPercent(1, 2, 1, weights)).toBe(99);
    expect(getChapterProgressPercent(2, 2, 0, weights)).toBe(99);
    expect(getChapterProgressPercent(2, 2, 0.99, weights)).toBe(99);
    expect(getChapterProgressPercent(2, 2, 1, weights)).toBe(100);
  });
});
