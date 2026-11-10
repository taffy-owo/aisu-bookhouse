import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef } from 'react';
import { useDialogViewport } from './useDialogViewport';

vi.mock('react', () => ({ useLayoutEffect: vi.fn(), useRef: vi.fn() }));

class VisibleViewport extends EventTarget {
  height = 400;
  width = 390;
  offsetTop = 70;
  offsetLeft = 0;
  scale = 1;
}

class FocusedField {
  matches = () => true;
  getBoundingClientRect = () => ({ top: 310, bottom: 410 });
  scrollIntoView = vi.fn();
}

let viewport: VisibleViewport;
let properties: Map<string, string>;
let dataset: Record<string, string>;
let frames: Map<number, FrameRequestCallback>;
let container: EventTarget;
let cleanup: (() => void) | void;

beforeEach(() => {
  viewport = new VisibleViewport(); properties = new Map(); dataset = {}; frames = new Map();
  let frameId = 0;
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    innerHeight: 844, innerWidth: 390, visualViewport: viewport,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  }));
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', FocusedField);
  container = new EventTarget();
  vi.mocked(useRef).mockReturnValue({ current: Object.assign(container, { style: { setProperty: (key: string, value: string) => properties.set(key, value) }, dataset, contains: () => true }) });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });

function useViewportFixture() {
  useDialogViewport();
  return vi.mocked(useLayoutEffect).mock.calls[0][0]();
}
function paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); }

describe('dialog visible viewport', () => {
  it('sizes and positions the dialog before its first paint when the keyboard is already open', () => {
    cleanup = useViewportFixture();
    expect(Object.fromEntries(properties)).toEqual({
      '--dialog-viewport-height': '400px', '--dialog-viewport-width': '390px',
      '--dialog-viewport-top': '70px', '--dialog-viewport-left': '0px',
    });
    expect(dataset.viewportCompact).toBe('true');
  });

  it('coalesces keyboard and panning events and restores the full dialog after keyboard dismissal', () => {
    cleanup = useViewportFixture();
    viewport.height = 844; viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);
    paint();
    expect(properties.get('--dialog-viewport-height')).toBe('844px');
    expect(properties.get('--dialog-viewport-top')).toBe('0px');
    expect(dataset.viewportCompact).toBe('false');
    viewport.width = 195; viewport.offsetLeft = 90;
    viewport.dispatchEvent(new Event('scroll')); paint();
    expect(properties.get('--dialog-viewport-width')).toBe('195px');
    expect(properties.get('--dialog-viewport-left')).toBe('90px');
  });

  it('uses the window dimensions when visual viewport information is unavailable', () => {
    Object.assign(window, { visualViewport: undefined });
    cleanup = useViewportFixture();
    expect(properties.get('--dialog-viewport-height')).toBe('844px');
    expect(properties.get('--dialog-viewport-width')).toBe('390px');
    Object.assign(window, { innerHeight: 320, innerWidth: 844 });
    window.dispatchEvent(new Event('resize')); paint();
    expect(properties.get('--dialog-viewport-height')).toBe('320px');
    expect(properties.get('--dialog-viewport-width')).toBe('844px');
    expect(dataset.viewportCompact).toBe('true');
  });

  it('removes listeners and pending updates when its dialog closes', () => {
    cleanup = useViewportFixture(); viewport.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(1);
    cleanup?.(); cleanup = undefined;
    expect(frames.size).toBe(0);
    viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')); container.dispatchEvent(new Event('focusin'));
    expect(frames.size).toBe(0);
  });

  it('reveals a focused field clipped by the keyboard without forcing it back during viewport panning', () => {
    const field = new FocusedField();
    Object.assign(document, { activeElement: field });
    cleanup = useViewportFixture();
    viewport.height = 300; viewport.dispatchEvent(new Event('resize')); paint();
    expect(field.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' });
    viewport.offsetTop = 100; viewport.dispatchEvent(new Event('scroll')); paint();
    expect(field.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('does not recenter a focused field when the user zooms', () => {
    const field = new FocusedField();
    Object.assign(document, { activeElement: field });
    cleanup = useViewportFixture();
    viewport.scale = 2; viewport.height = 200; viewport.dispatchEvent(new Event('resize')); paint();
    expect(field.scrollIntoView).not.toHaveBeenCalled();
  });

  it('reveals an autofocus field when a new dialog opens over an existing keyboard', () => {
    cleanup = useViewportFixture();
    const field = new FocusedField();
    field.getBoundingClientRect = () => ({ top: 410, bottom: 510 });
    Object.assign(document, { activeElement: field });
    container.dispatchEvent(new Event('focusin')); paint();
    expect(field.scrollIntoView).toHaveBeenCalledOnce();
  });
});
