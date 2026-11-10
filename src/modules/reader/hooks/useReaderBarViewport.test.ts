import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef } from 'react';
import { useReaderBarViewport } from './useReaderBarViewport';
import { READER_CONTROLS_LAYOUT_EVENT } from '../utils/readerControlsLayout';

vi.mock('react', () => ({ useLayoutEffect: vi.fn(), useRef: vi.fn() }));

class Bar extends EventTarget {
  dataset: Record<string, string> = {};
  height = 53;
  get scrollHeight() { return this.height; }
  style = {
    top: '', left: '', right: '', width: '', bottom: '', maxHeight: '', paddingInline: '',
    removeProperty: (name: string) => { (this.style as unknown as Record<string, string>)[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = ''; },
  };
  getBoundingClientRect() {
    const top = Number.parseFloat(this.style.top) || 0;
    const left = Number.parseFloat(this.style.left) || 0;
    const height = Math.min(this.height, Number.parseFloat(this.style.maxHeight) || this.height);
    return { top, left, height, width: Number.parseFloat(this.style.width) || 390, bottom: top + height };
  }
  closest(): { querySelector: () => { getBoundingClientRect: () => { left: number } } } | null { return null; }
}

let bar: Bar;
let viewport: EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number; scale: number };
let frames: Map<number, () => void>;
let cleanup: void | (() => void);
beforeEach(() => {
  bar = new Bar(); frames = new Map(); let nextFrame = 0;
  viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
  vi.mocked(useRef).mockReturnValue({ current: bar });
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    innerWidth: 390, innerHeight: 844, visualViewport: viewport,
    requestAnimationFrame: (fn: () => void) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
function useBarFixture(edge: 'top' | 'bottom' = 'top') { useReaderBarViewport(edge); return vi.mocked(useLayoutEffect).mock.calls[0][0](); }
function paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); }

describe('reader controls in the visual viewport', () => {
  it('leaves normal layout and the docked catalogue CSS in charge at normal zoom', () => {
    cleanup = useBarFixture();
    expect(bar.style.width).toBe(''); expect(bar.style.top).toBe('');
    expect(bar.dataset.readerBarLayoutHeight).toBe('53');
    expect(bar.dataset.readerViewportAdjusted).toBe('false');
  });
  it('anchors the top bar inside a zoomed, panned viewport', () => {
    Object.assign(viewport, { width: 195, height: 422, offsetTop: 100, offsetLeft: 90, scale: 2 });
    cleanup = useBarFixture();
    expect(bar.style.left).toBe('90px'); expect(bar.style.width).toBe('195px');
    expect(bar.style.top).toBe('100px'); expect(bar.dataset.readerBarLayoutHeight).toBe('53');
    viewport.offsetLeft = 140; viewport.offsetTop = 180; viewport.dispatchEvent(new Event('scroll')); paint();
    expect(bar.style.left).toBe('140px'); expect(bar.style.top).toBe('180px');
  });
  it('keeps the bottom bar above the keyboard and fits tall controls by internal scrolling', () => {
    Object.assign(viewport, { height: 300, offsetTop: 40 }); bar.height = 220;
    cleanup = useBarFixture('bottom');
    expect(bar.getBoundingClientRect()).toMatchObject({ top: 205, height: 135, bottom: 340 });
  });
  it('also limits tall controls in an unzoomed short landscape screen', () => {
    viewport.height = 100; Object.assign(window, { innerHeight: 100 });
    cleanup = useBarFixture();
    expect(bar.getBoundingClientRect()).toMatchObject({ top: 0, height: 45 });
    viewport.dispatchEvent(new Event('resize')); paint();
    expect(bar.style.maxHeight).toBe('45px');
  });
  it('preserves the natural header height when zoom causes its buttons to wrap', () => {
    cleanup = useBarFixture();
    Object.assign(viewport, { width: 195, height: 422, scale: 2 }); bar.height = 137;
    viewport.dispatchEvent(new Event('resize')); paint();
    expect(bar.dataset.readerBarLayoutHeight).toBe('53');
    Object.assign(viewport, { width: 390, height: 844, scale: 1 }); bar.height = 53;
    viewport.dispatchEvent(new Event('resize')); paint();
    expect(bar.style.left).toBe(''); expect(bar.style.width).toBe(''); expect(bar.style.maxHeight).toBe('');
    expect(bar.dataset.readerViewportAdjusted).toBe('false');
  });
  it('does not place zoomed controls over a docked catalogue', () => {
    Object.assign(viewport, { width: 300, offsetLeft: 500, scale: 2 });
    vi.spyOn(bar, 'closest').mockReturnValue({ querySelector: () => ({ getBoundingClientRect: () => ({ left: 700 }) }) });
    cleanup = useBarFixture();
    expect(bar.style.left).toBe('500px'); expect(bar.style.width).toBe('200px');
  });
  it('notifies reading and listening layout after moving, without repeat events for unchanged geometry', () => {
    const notify = vi.fn(); bar.addEventListener(READER_CONTROLS_LAYOUT_EVENT, notify);
    cleanup = useBarFixture(); expect(notify).toHaveBeenCalledOnce();
    viewport.dispatchEvent(new Event('resize')); paint(); expect(notify).toHaveBeenCalledOnce();
    viewport.offsetTop = 20; viewport.dispatchEvent(new Event('scroll')); paint(); expect(notify).toHaveBeenCalledTimes(2);
  });
  it('releases pending frames and listeners after unmounting', () => {
    cleanup = useBarFixture(); viewport.dispatchEvent(new Event('resize')); expect(frames.size).toBe(1);
    cleanup?.(); cleanup = undefined;
    viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(0);
  });
});
