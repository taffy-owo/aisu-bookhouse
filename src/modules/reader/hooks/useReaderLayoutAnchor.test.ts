import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { useReaderLayoutAnchor } from './useReaderLayoutAnchor';
import { captureReaderViewportAnchor, restoreReaderViewportAnchor } from '../utils/readerViewportAnchor';
import { AUDIOBOOK_FOLLOW_EVENT } from '../utils/audiobookTextFollow';

vi.mock('react', () => ({
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
const account = vi.hoisted(() => ({ scope: 'reader' }));
vi.mock('../../../shared/api', () => ({ getAccountScope: () => account.scope }));
vi.mock('../utils/readerViewportAnchor', () => ({
  captureReaderViewportAnchor: vi.fn(), restoreReaderViewportAnchor: vi.fn(),
}));

class Surface extends EventTarget {
  isConnected = true;
  offsetHeight = 3000;
  offsetWidth = 600;
  scrollTop = 1000;
  querySelector = () => content;
}

let shell: Surface, content: Surface;
let frames: Map<number, () => void>, timers: Map<number, () => void>;
let resizeContent: () => void;
let cleanups: Array<() => void>;
let fonts: EventTarget;
let startupRestoring: boolean;
const restored = vi.fn();
function paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); }
function settle() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); }
function useLayoutFixture() {
  useReaderLayoutAnchor({
    contentKey: 'book:chapter', enabled: true, getScrollElement: () => shell as unknown as HTMLElement,
    isPanelOpen: false, layoutKey: 'scroll', onRestore: restored, shellRef: { current: shell as unknown as HTMLElement },
    isRestoringPosition: () => startupRestoring,
  });
  for (const [effect] of vi.mocked(useEffect).mock.calls) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  paint();
}

beforeEach(() => {
  shell = new Surface(); content = new Surface(); fonts = new EventTarget();
  frames = new Map(); timers = new Map(); cleanups = []; account.scope = 'reader';
  startupRestoring = false;
  let nextId = 0;
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    innerWidth: 1000,
    requestAnimationFrame: (callback: () => void) => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (callback: () => void) => { timers.set(++nextId, callback); return nextId; },
    clearTimeout: (id: number) => timers.delete(id),
  }));
  vi.stubGlobal('document', { scrollingElement: null, fonts });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeContent = callback; }
    observe() {}
    disconnect() {}
  });
  // Model a paragraph below delayed content: its document coordinate grows
  // by the new content height, while its logical text position stays fixed.
  vi.mocked(captureReaderViewportAnchor).mockImplementation(() => ({
    blockIndex: shell.scrollTop - (content.offsetHeight - 3000), blockText: 'paragraph', offsetRatio: 0, viewportOffset: 80,
  }));
  vi.mocked(restoreReaderViewportAnchor).mockImplementation((_shell, _scroll, anchor) => {
    shell.scrollTop = anchor.blockIndex + content.offsetHeight - 3000;
    return shell.scrollTop / (content.offsetHeight - 500);
  });
});
afterEach(() => { cleanups.forEach(cleanup => cleanup()); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('reader position during delayed layout', () => {
  it('preserves the text after reading begins, even if native anchoring emits a scroll before resize', () => {
    useLayoutFixture(); window.dispatchEvent(new Event('wheel'));
    content.offsetHeight = 3500;
    shell.scrollTop = 1250;
    shell.dispatchEvent(new Event('scroll')); paint();
    resizeContent();
    expect(shell.scrollTop).toBe(1500);
    expect(restored).toHaveBeenLastCalledWith(0.5);
  });

  it('leaves untouched startup progress to the startup restorer', () => {
    useLayoutFixture(); content.offsetHeight = 3500;
    resizeContent(); fonts.dispatchEvent(new Event('loadingdone'));
    expect(restored).not.toHaveBeenCalled();
  });

  it('preserves native scrolling without DOM input events when delayed content reflows', () => {
    useLayoutFixture();
    shell.scrollTop = 1100;
    shell.dispatchEvent(new Event('scroll')); paint(); settle();
    content.offsetHeight = 3500;
    shell.scrollTop = 1350;
    shell.dispatchEvent(new Event('scroll')); paint();
    resizeContent();
    expect(shell.scrollTop).toBe(1600);
    expect(restored).toHaveBeenLastCalledWith(1600 / 3000);
  });

  it('does not mistake an unfinished startup restore for native reading', () => {
    startupRestoring = true;
    useLayoutFixture();
    shell.scrollTop = 1100;
    shell.dispatchEvent(new Event('scroll')); paint();
    content.offsetHeight = 3500;
    resizeContent(); fonts.dispatchEvent(new Event('loadingdone'));
    expect(restored).not.toHaveBeenCalled();
  });

  it.each(['detached-shell', 'detached-body', 'zero-height', 'different-account'])('does not overwrite progress for %s', (state) => {
    useLayoutFixture(); window.dispatchEvent(new Event('wheel')); content.offsetHeight = 3500;
    if (state === 'detached-shell') shell.isConnected = false;
    if (state === 'detached-body') content.isConnected = false;
    if (state === 'zero-height') content.offsetHeight = 0;
    if (state === 'different-account') account.scope = 'another-reader';
    resizeContent(); fonts.dispatchEvent(new Event('loadingdone')); settle();
    expect(restored).not.toHaveBeenCalled();
  });

  it('treats audiobook following as reading before a delayed illustration changes size', () => {
    useLayoutFixture(); window.dispatchEvent(new Event(AUDIOBOOK_FOLLOW_EVENT)); content.offsetHeight = 3500;
    resizeContent();
    expect(shell.scrollTop).toBe(1500);
    expect(restored).toHaveBeenCalledOnce();
  });

  it('measures characters after scrolling settles and cancels pending work on cleanup', () => {
    useLayoutFixture();
    for (let index = 0; index < 60; index++) {
      shell.scrollTop += 8; shell.dispatchEvent(new Event('scroll')); paint();
    }
    expect(vi.mocked(captureReaderViewportAnchor).mock.calls.every(call => !call[3])).toBe(true);
    settle();
    expect(vi.mocked(captureReaderViewportAnchor).mock.calls.filter(call => call[3])).toHaveLength(1);
    shell.dispatchEvent(new Event('scroll'));
    cleanups.splice(0).forEach(cleanup => cleanup());
    expect(frames.size).toBe(0); expect(timers.size).toBe(0);
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(restored).not.toHaveBeenCalled();
  });
});
