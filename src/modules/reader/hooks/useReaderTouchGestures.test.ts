import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { useReaderTouchGestures } from './useReaderTouchGestures';

vi.mock('react', () => ({ useEffect: vi.fn(), useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }) }));

class ReadingTarget extends EventTarget {
  kind = 'text';
  closest(selector: string) {
    if (this.kind === 'ruby' && selector.includes('ruby')) return this;
    if (this.kind === 'image' && selector.includes('[data-reader-edge-page-turn]')) return this;
    if (this.kind === 'button' && selector.includes('button')) return this;
    return null;
  }
  getBoundingClientRect() { return { left: 100, width: 400 }; }
}

let target: ReadingTarget;
let selected: boolean;
let cleanups: Array<() => void>;
let page: EventTarget;
beforeEach(() => {
  target = new ReadingTarget(); selected = false; cleanups = [];
  page = new EventTarget();
  vi.stubGlobal('document', page);
  vi.stubGlobal('Element', ReadingTarget);
  vi.stubGlobal('window', { innerWidth: 600, getSelection: () => ({ isCollapsed: !selected, toString: () => selected ? 'selected text' : '' }) });
});
afterEach(() => { cleanups.forEach(fn => fn()); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function useGestureFixture(allowRubyEdgePageTurns = true) {
  const onTap = vi.fn(), onSwipeLeft = vi.fn();
  const controls = useReaderTouchGestures({ enabled: true, targetRef: { current: target as unknown as HTMLElement }, allowRubyEdgePageTurns, onTap, onSwipeLeft });
  for (const [effect] of vi.mocked(useEffect).mock.calls) {
    const cleanup = effect(); if (cleanup) cleanups.push(cleanup);
  }
  return { ...controls, onTap, onSwipeLeft };
}
function touch(type: string, x: number, y = 250) {
  const point = { clientX: x, clientY: y };
  if (type === 'touchstart') page.dispatchEvent(new Event(type));
  target.dispatchEvent(Object.assign(new Event(type), { touches: type === 'touchend' ? [] : [point], changedTouches: [point] }));
}
function tap(x: number) { touch('touchstart', x); touch('touchend', x); }
function compatibilityClick(x = 450, y = 250, detail = 1, pointerType = 'touch') {
  const event = Object.assign(new Event('click', { cancelable: true }), { clientX: x, clientY: y, detail, pointerType });
  page.dispatchEvent(event);
  return event;
}

describe('reader touch arbitration', () => {
  it('handles side taps over ruby once and suppresses the compatibility click', () => {
    target.kind = 'ruby'; const { onTap, shouldIgnoreClick } = useGestureFixture();
    tap(450);
    expect(onTap).toHaveBeenCalledWith({ clientX: 450, clientY: 250 });
    const click = compatibilityClick();
    expect(click.defaultPrevented).toBe(true);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(shouldIgnoreClick()).toBe(true);
    tap(150); expect(onTap).toHaveBeenCalledTimes(2);
  });
  it('blocks a retargeted click once even when the toolbar is outside the reading surface', () => {
    const { onTap } = useGestureFixture();
    tap(450);
    expect(compatibilityClick().defaultPrevented).toBe(true);
    expect(compatibilityClick().defaultPrevented).toBe(false);
    expect(onTap).toHaveBeenCalledOnce();
  });
  it('lets a new gesture immediately use the revealed controls', () => {
    useGestureFixture();
    for (const type of ['pointerdown', 'touchstart']) {
      tap(450);
      page.dispatchEvent(new Event(type));
      expect(compatibilityClick().defaultPrevented).toBe(false);
    }
  });
  it('preserves keyboard, programmatic, mouse and unrelated clicks', () => {
    useGestureFixture();
    tap(450);
    expect(compatibilityClick(450, 250, 0).defaultPrevented).toBe(false);
    expect(compatibilityClick(450, 250, 1, 'mouse').defaultPrevented).toBe(false);
    expect(compatibilityClick(300).defaultPrevented).toBe(false);
    expect(compatibilityClick(451, 251, 1, '').defaultPrevented).toBe(true);
  });
  it('releases a stale click guard after its timeout and removes listeners on unmount', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    useGestureFixture(); tap(450);
    now.mockReturnValue(1801);
    expect(compatibilityClick().defaultPrevented).toBe(false);
    tap(450);
    cleanups.splice(0).forEach(fn => fn());
    expect(compatibilityClick().defaultPrevented).toBe(false);
    now.mockRestore();
  });
  it('preserves central ruby taps and respects disabling ruby edge paging', () => {
    target.kind = 'ruby'; const { onTap } = useGestureFixture(false);
    tap(450); tap(300); expect(onTap).not.toHaveBeenCalled();
  });
  it('leaves the center ruby action to the annotation', () => {
    target.kind = 'ruby'; const { onTap } = useGestureFixture();
    tap(300); expect(onTap).not.toHaveBeenCalled();
  });
  it('preserves buttons, scrolling and the first tap that dismisses a selection', () => {
    const { onTap } = useGestureFixture();
    target.kind = 'button'; tap(450); target.kind = 'text';
    touch('touchstart', 450); touch('touchmove', 450, 100); touch('touchend', 450, 100);
    selected = true; touch('touchstart', 450); selected = false; touch('touchend', 450);
    expect(onTap).not.toHaveBeenCalled();
    tap(450); expect(onTap).toHaveBeenCalledOnce();
  });
  it('recognizes pen input and touch compatibility clicks without classifying mouse input as touch', () => {
    const { isTouchClick } = useGestureFixture();
    expect(isTouchClick({ pointerType: 'pen' } as unknown as MouseEvent)).toBe(true);
    expect(isTouchClick({ pointerType: 'touch' } as unknown as MouseEvent)).toBe(true);
    expect(isTouchClick({ sourceCapabilities: { firesTouchEvents: true } } as unknown as MouseEvent)).toBe(true);
    expect(isTouchClick({ pointerType: 'mouse' } as unknown as MouseEvent)).toBe(false);
  });
});
