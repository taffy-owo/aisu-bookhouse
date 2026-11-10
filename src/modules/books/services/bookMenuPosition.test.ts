import { describe, expect, it } from 'vitest';
import { getBookMenuPosition } from './bookMenuPosition';

describe('book menu placement', () => {
  const viewport = { left: 0, right: 390, top: 70, bottom: 782 };

  it('opens above a low trigger and clears bottom navigation', () => {
    const result = getBookMenuPosition({ top: 700, bottom: 744, right: 179 }, viewport, 102);
    expect(result).toMatchObject({ left: 35, top: 590, width: 144 });
    expect(result.top + 102).toBeLessThan(700);
  });

  it('opens below a trigger with enough space', () => {
    expect(getBookMenuPosition({ top: 150, bottom: 194, right: 179 }, viewport, 102)).toMatchObject({ top: 202 });
  });

  it('keeps an edge-column menu away from the screen edges', () => {
    expect(getBookMenuPosition({ top: 150, bottom: 194, right: 140 }, viewport, 102).left).toBe(8);
    expect(getBookMenuPosition({ top: 150, bottom: 194, right: 400 }, viewport, 102).left).toBe(238);
  });

  it('uses the visible viewport offsets when zoomed', () => {
    expect(getBookMenuPosition({ top: 320, bottom: 364, right: 230 }, { left: 100, right: 300, top: 200, bottom: 400 }, 102)).toEqual({ left: 108, top: 210, width: 144, maxHeight: 104 });
  });

  it('constrains a menu to the larger side in a short viewport', () => {
    expect(getBookMenuPosition({ top: 160, bottom: 204, right: 179 }, { ...viewport, bottom: 250 }, 102)).toMatchObject({ top: 78, maxHeight: 74 });
  });

  it('reduces width when the visible viewport is narrower than the menu', () => {
    expect(getBookMenuPosition({ top: 150, bottom: 194, right: 179 }, { ...viewport, right: 120 }, 102)).toMatchObject({ left: 8, width: 104 });
  });

  it('caps a long detail menu at its intended height even with more room', () => {
    const result = getBookMenuPosition({ top: 150, bottom: 194, right: 300 }, viewport, 420, { width: 224, maxHeight: 352 });
    expect(result).toMatchObject({ left: 76, top: 202, width: 224, maxHeight: 352 });
  });

  it('keeps the detail menu above bottom navigation with an eight-pixel gap', () => {
    const result = getBookMenuPosition({ top: 300, bottom: 344, right: 300 }, { ...viewport, bottom: 502 }, 420, { width: 224, maxHeight: 352 });
    expect(result).toMatchObject({ top: 78, maxHeight: 214 });
    expect(result.top + result.maxHeight).toBe(292);
  });

  it('fits a detail menu into a zoomed viewport instead of its layout viewport', () => {
    const result = getBookMenuPosition({ top: 399.5, bottom: 443.5, right: 72 }, { left: 0, right: 195, top: 70, bottom: 422 }, 420, { width: 224, maxHeight: 352 });
    expect(result).toEqual({ left: 8, top: 78, width: 179, maxHeight: 313.5 });
  });
});
