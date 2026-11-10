import { describe, expect, it } from 'vitest';
import { getMangaImageSize, getMangaPageFitMode, getMangaZoomAnchor } from './mangaPageLayout';

describe('getMangaPageFitMode', () => {
  it('fits ordinary portrait and landscape pages entirely on screen', () => {
    expect(getMangaPageFitMode(1512, 2150)).toBe('screen');
    expect(getMangaPageFitMode(2150, 1512)).toBe('screen');
  });

  it('fits long-strip manga pages by width so their text stays readable', () => {
    expect(getMangaPageFitMode(1000, 5636)).toBe('width');
  });

  it('falls back to screen fitting before the image dimensions are known', () => {
    expect(getMangaPageFitMode(0, 0)).toBe('screen');
  });
});

describe('manga image geometry', () => {
  it('scales the fitted portrait image rather than the viewport width', () => {
    expect(getMangaImageSize(600, 800, 1500, 800, 1)).toEqual({ width: 600, height: 800 });
    expect(getMangaImageSize(600, 800, 1500, 800, 1.25)).toEqual({ width: 750, height: 1000 });
    expect(getMangaImageSize(800, 600, 400, 800, 1.25)).toEqual({ width: 500, height: 375 });
  });

  it('keeps strips readable by width and caps their fit width on wide screens', () => {
    expect(getMangaImageSize(600, 3000, 400, 800, 1)).toEqual({ width: 400, height: 2000 });
    expect(getMangaImageSize(600, 3000, 1600, 800, 3)).toEqual({ width: 3600, height: 18000 });
  });

  it('waits for valid natural and available dimensions', () => {
    expect(getMangaImageSize(0, 800, 400, 800, 1)).toBeNull();
    expect(getMangaImageSize(600, 800, 400, -1, 1)).toBeNull();
    expect(getMangaImageSize(Infinity, 800, 400, 800, 1)).toBeNull();
  });

  it('remembers the viewed point inside a scrolled image', () => {
    expect(getMangaZoomAnchor({ left: -200, top: -400, width: 1200, height: 1600 }, { left: 0, top: 0, width: 400, height: 800 }))
      .toEqual({ imageX: 1 / 3, imageY: 0.5, viewportX: 0.5, viewportY: 0.5 });
    expect(getMangaZoomAnchor({ left: 0, top: 0, width: 1200, height: 1600 }, { left: 0, top: 0, width: 400, height: 800 }, { x: 100, y: 200 }))
      .toEqual({ imageX: 1 / 12, imageY: 0.125, viewportX: 0.25, viewportY: 0.25 });
  });

  it('clamps a click in the margin to the nearest image edge', () => {
    expect(getMangaZoomAnchor({ left: 200, top: 100, width: 400, height: 600 }, { left: 0, top: 0, width: 800, height: 800 }, { x: 50, y: 0 }))
      .toEqual({ imageX: 0, imageY: 0, viewportX: 0.0625, viewportY: 0 });
  });
});
