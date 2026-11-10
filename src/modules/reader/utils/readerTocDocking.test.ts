import { describe, expect, it } from 'vitest';
import { canDockReaderToc } from './readerTocDocking';

describe('reader catalogue docking', () => {
  const viewport = { width: 1536, height: 864, offsetLeft: 0, offsetTop: 0, scale: 1 };
  it('keeps the normal desktop catalogue docked, including harmless subpixel rounding', () => {
    expect(canDockReaderToc(viewport, 1536, 864)).toBe(true);
    expect(canDockReaderToc({ ...viewport, width: 1535.5, height: 863.5 }, 1536, 864)).toBe(true);
  });
  it('uses a visible modal for pinch zoom, even when its visible area is still wider than 1024px', () => {
    expect(canDockReaderToc({ ...viewport, width: 1228.8, height: 691.2, scale: 1.25 }, 1536, 864)).toBe(false);
    expect(canDockReaderToc({ ...viewport, width: 768, height: 432, scale: 2 }, 1536, 864)).toBe(false);
  });
  it('does not dock outside a panned viewport or behind a keyboard', () => {
    expect(canDockReaderToc({ ...viewport, offsetLeft: 100 }, 1536, 864)).toBe(false);
    expect(canDockReaderToc({ ...viewport, offsetTop: 100 }, 1536, 864)).toBe(false);
    expect(canDockReaderToc({ ...viewport, height: 432 }, 1536, 864)).toBe(false);
  });
  it('retains the desktop fallback when visualViewport is unavailable', () => {
    expect(canDockReaderToc(undefined, 1536, 864)).toBe(true);
  });
});
