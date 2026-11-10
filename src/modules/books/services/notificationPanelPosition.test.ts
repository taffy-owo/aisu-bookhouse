import { describe, expect, it } from 'vitest';
import { getNotificationPanelPosition } from './notificationPanelPosition';

describe('notification visible-viewport placement', () => {
  it('stays aligned beneath the trigger when the viewport has enough space', () => {
    expect(getNotificationPanelPosition({ right: 1403, bottom: 67 }, { width: 1536, height: 864, offsetLeft: 0, offsetTop: 0 }))
      .toEqual({ left: 1043, top: 77, width: 360, maxHeight: 779 });
  });

  it('keeps a zoomed panel inside a panned visual viewport', () => {
    expect(getNotificationPanelPosition({ right: 365, bottom: 132 }, { width: 195, height: 422, offsetLeft: 90, offsetTop: 210 }))
      .toEqual({ left: 98, top: 218, width: 179, maxHeight: 406 });
  });

  it.each([{ width: 320, height: 180 }, { width: 180, height: 240 }, { width: 12, height: 10 }])('retains usable bounds in a $width by $height viewport', ({ width, height }) => {
    const viewport = { width, height, offsetLeft: 120, offsetTop: 200 };
    const panel = getNotificationPanelPosition({ right: 900, bottom: 900 }, viewport);
    expect(panel.left).toBeGreaterThanOrEqual(viewport.offsetLeft);
    expect(panel.top).toBeGreaterThanOrEqual(viewport.offsetTop);
    expect(panel.left + panel.width).toBeLessThanOrEqual(viewport.offsetLeft + width);
    expect(panel.top + panel.maxHeight).toBeLessThanOrEqual(viewport.offsetTop + height);
    expect(panel.width).toBeGreaterThanOrEqual(0);
    expect(panel.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it('clamps offscreen anchors to the visible area instead of the layout origin', () => {
    const panel = getNotificationPanelPosition({ right: 0, bottom: 0 }, { width: 390, height: 500, offsetLeft: 120, offsetTop: 200 });
    expect(panel.left).toBe(128);
    expect(panel.top).toBe(208);
    expect(panel.maxHeight).toBe(484);
  });
});
