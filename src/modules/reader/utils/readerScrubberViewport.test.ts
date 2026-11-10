import { describe, expect, it } from 'vitest';
import { getReaderScrubberViewport } from './readerScrubberViewport';

describe('visible desktop reading scrubber', () => {
  const viewport = { offsetLeft: 200, offsetTop: 100, width: 768, height: 432 };
  it('stays inside a zoomed and panned viewport, between visible controls', () => {
    const bounds = getReaderScrubberViewport(viewport, { top: 100, bottom: 153 }, { top: 500, bottom: 532 })!;
    expect(bounds).toEqual({ left: 956, top: 156, width: 12, height: 341 });
    expect(bounds.left + bounds.width).toBe(viewport.offsetLeft + viewport.width);
  });
  it('ignores reader bars outside the visible part of the page', () => {
    expect(getReaderScrubberViewport(viewport, { top: 0, bottom: 53 }, { top: 800, bottom: 864 }))
      .toEqual({ left: 956, top: 103, width: 12, height: 426 });
  });
  it('does not cover a docked catalogue or appear in a viewport showing only the catalogue', () => {
    const bounds = getReaderScrubberViewport(viewport, undefined, undefined, 700)!;
    expect(bounds.left + bounds.width).toBe(700);
    expect(getReaderScrubberViewport({ ...viewport, offsetLeft: 750 }, undefined, undefined, 700)).toBeNull();
  });
  it('fits very narrow visible content without overflowing to its left', () => {
    expect(getReaderScrubberViewport(viewport, undefined, undefined, 205))
      .toMatchObject({ left: 200, width: 5 });
  });
  it('hides the track when visible controls leave no reading space', () => {
    expect(getReaderScrubberViewport(viewport, { top: 100, bottom: 320 }, { top: 300, bottom: 532 })).toBeNull();
  });
});
