import { describe, expect, it } from 'vitest';
import { getAudiobookFollowScrollTop } from './audiobookTextFollow';

describe('audiobook text following', () => {
  it('keeps a paragraph already in the comfortable reading area in place', () => {
    expect(getAudiobookFollowScrollTop({ top: 260, bottom: 320 }, { top: 100, bottom: 600 }, 1800)).toBeNull();
  });
  it('brings an off-screen spoken paragraph above the player in a document reader', () => {
    const top = getAudiobookFollowScrollTop({ top: 1700, bottom: 1820 }, { top: 65, bottom: 535 }, 1671)!;
    const movedTop = 1700 - (top - 1671);
    expect(movedTop).toBeGreaterThanOrEqual(65);
    expect(movedTop + 120).toBeLessThanOrEqual(535);
  });
  it('centers a paragraph in the available nested reader viewport', () => {
    expect(getAudiobookFollowScrollTop({ top: 1000, bottom: 1100 }, { top: 60, bottom: 540 }, 600)).toBe(1350);
  });
  it('shows the first lines of a paragraph longer than the visible screen', () => {
    const top = getAudiobookFollowScrollTop({ top: 1000, bottom: 2200 }, { top: 60, bottom: 540 }, 600)!;
    expect(1000 - (top - 600)).toBe(108);
  });
  it('never requests a negative document scroll position', () => {
    expect(getAudiobookFollowScrollTop({ top: 60, bottom: 100 }, { top: 60, bottom: 540 }, 0)).toBe(0);
  });
  it.each([
    [{ top: 0, bottom: 20 }, { top: 100, bottom: 100 }, 0],
    [{ top: 20, bottom: 0 }, { top: 0, bottom: 200 }, 0],
    [{ top: Number.NaN, bottom: 20 }, { top: 0, bottom: 200 }, 0],
    [{ top: 0, bottom: 20 }, { top: 0, bottom: 200 }, Number.POSITIVE_INFINITY],
  ])('ignores unavailable or invalid viewport geometry', (target, viewport, scrollTop) => {
    expect(getAudiobookFollowScrollTop(target, viewport, scrollTop)).toBeNull();
  });
});
