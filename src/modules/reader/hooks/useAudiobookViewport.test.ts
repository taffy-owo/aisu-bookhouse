import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef } from 'react';
import { useAudiobookViewport } from './useAudiobookViewport';

vi.mock('react', () => ({ useLayoutEffect: vi.fn(), useRef: vi.fn() }));

class Surface extends EventTarget {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  inert = false;
  visibility = 'visible';
  scrollTop = 0;
  top = 0;
  height = 200;
  get scrollHeight() { return this.height; }
  get offsetHeight() { return this.getBoundingClientRect().height; }
  get clientHeight() { return this.offsetHeight; }
  elements = new Map<string, Surface>();
  getBoundingClientRect() {
    const top = Number.parseFloat(this.style.top) || this.top;
    const height = Math.min(this.height, Number.parseFloat(this.style.maxHeight) || this.height);
    return { top, height, bottom: top + height };
  }
  querySelector(selector: string) { return this.elements.get(selector) ?? null; }
  closest() { return root; }
  contains() { return false; }
}

let root: Surface, player: Surface, header: Surface, footer: Surface, status: Surface;
let viewport: EventTarget & { offsetTop: number; offsetLeft: number; height: number; width: number };
let frames: Map<number, () => void>;
let cleanup: void | (() => void);
beforeEach(() => {
  root = new Surface(); player = new Surface(); header = new Surface(); footer = new Surface(); status = new Surface();
  header.height = 53; footer.top = 680; footer.height = 120; status.top = 774; status.height = 26;
  root.elements = new Map([['.reader-chrome-top', header], ['.reader-bottom-bar', footer], ['.reader-reading-status', status]]);
  viewport = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, height: 800, width: 390 });
  frames = new Map(); let frameId = 0;
  vi.mocked(useRef).mockReturnValue({ current: player });
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    innerWidth: 390, innerHeight: 800, visualViewport: viewport,
    requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }));
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', Surface);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('getComputedStyle', (element: Surface) => ({ visibility: element.visibility }));
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
function useViewportFixture(isOpen = true) { useAudiobookViewport(isOpen, true); return vi.mocked(useLayoutEffect).mock.calls[0][0](); }
function paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); }

describe('floating audiobook viewport', () => {
  it('keeps the player above visible controls before its first paint', () => {
    cleanup = useViewportFixture();
    expect(player.getBoundingClientRect()).toEqual({ top: 468, height: 200, bottom: 668 });
    expect(player.style.width).toBe('366px');
    expect(player.style.left).toBe('12px');
    expect(player.dataset.viewportCompact).toBe('true');
  });
  it('reserves fading bars until their transition finishes, then follows the status strip', () => {
    cleanup = useViewportFixture(); footer.inert = true;
    root.dispatchEvent(new Event('transitionend')); paint();
    expect(player.getBoundingClientRect().bottom).toBe(668);
    footer.visibility = 'hidden'; root.dispatchEvent(new Event('transitionend')); paint();
    expect(player.getBoundingClientRect().bottom).toBe(762);
    expect(player.dataset.readerPlayerReservedTop).toBe('468');
  });
  it('keeps its chapter-tail reservation stable when the controls constrain a tall player', () => {
    viewport.height = 390; footer.top = 300; status.top = 364; player.height = 260;
    cleanup = useViewportFixture();
    expect(player.getBoundingClientRect().height).toBe(223);
    expect(player.dataset.readerPlayerReservedTop).toBe('65');
    header.inert = footer.inert = true; header.visibility = footer.visibility = 'hidden';
    root.dispatchEvent(new Event('transitionend')); paint();
    expect(player.getBoundingClientRect().height).toBe(260);
    expect(player.dataset.readerPlayerReservedTop).toBe('65');
  });
  it('follows zoom and pan offsets without reserving bars outside the visible area', () => {
    Object.assign(viewport, { offsetTop: 200, offsetLeft: 90, height: 400, width: 195 }); cleanup = useViewportFixture();
    expect(player.style.left).toBe('102px');
    expect(player.style.width).toBe('171px');
    expect(player.getBoundingClientRect().bottom).toBe(588);
    viewport.offsetLeft = 140; viewport.dispatchEvent(new Event('scroll')); paint();
    expect(player.style.left).toBe('152px');
  });
  it('limits tall players to the free space so controls can scroll internally', () => {
    viewport.height = 390; footer.top = 300; player.height = 500; cleanup = useViewportFixture();
    expect(player.getBoundingClientRect()).toEqual({ top: 65, height: 223, bottom: 288 });
  });
  it('uses the visible screen when bars would leave no usable control area', () => {
    viewport.height = 180; footer.top = 100; player.height = 500; cleanup = useViewportFixture();
    expect(player.getBoundingClientRect()).toEqual({ top: 12, height: 156, bottom: 168 });
  });
  it('uses window dimensions when visualViewport is unavailable', () => {
    Object.assign(window, { visualViewport: undefined }); cleanup = useViewportFixture();
    expect(player.style.width).toBe('366px');
    expect(player.getBoundingClientRect().bottom).toBe(668);
  });
  it('coalesces viewport events and releases updates after closing', () => {
    cleanup = useViewportFixture(); viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);
    cleanup?.(); cleanup = undefined;
    viewport.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); root.dispatchEvent(new Event('transitionend'));
    expect(frames.size).toBe(0);
  });
  it('does not observe a closed player', () => { cleanup = useViewportFixture(false); expect(player.style).toEqual({}); });
});
