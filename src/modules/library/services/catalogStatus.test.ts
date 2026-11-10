import { describe, expect, it } from 'vitest';
import { resolveActiveChapterIndex, resolveActivePageIndex } from './catalogStatus';

describe('catalogStatus', () => {
  it('prefers saved chapter index when available', () => {
    expect(resolveActiveChapterIndex({ chapterCount: 8, progressPercent: 57, savedChapterIndex: 6 })).toBe(6);
  });

  it('infers the active chapter from progress percent when only percent is available', () => {
    expect(resolveActiveChapterIndex({ chapterCount: 8, progressPercent: 57 })).toBe(5);
    expect(resolveActiveChapterIndex({ chapterCount: 8, progressPercent: 100 })).toBe(8);
  });

  it('does not highlight unread books', () => {
    expect(resolveActiveChapterIndex({ chapterCount: 8, progressPercent: 0 })).toBeNull();
  });

  it('supports comic page catalogs too', () => {
    expect(resolveActivePageIndex({ pageCount: 150, progressPercent: 57 })).toBe(86);
    expect(resolveActivePageIndex({ pageCount: 150, progressPercent: 57, savedPageIndex: 44 })).toBe(44);
  });
});
