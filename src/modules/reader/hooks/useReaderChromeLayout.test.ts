import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { useReaderChromeLayout } from './useReaderChromeLayout';
import { AUDIOBOOK_LAYOUT_EVENT } from '../utils/readerAudiobookPlayer';

vi.mock('react', () => ({ useLayoutEffect: vi.fn() }));

class Surface extends EventTarget {
  visibility = 'visible';
  properties = new Map<string, string>();
  style = {
    setProperty: (key: string, value: string) => this.properties.set(key, value),
    getPropertyValue: (key: string) => this.properties.get(key) ?? '',
    clipPath: '',
  };
  dataset: Record<string, string> = {};
  top: number;
  readonly height: number;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  elements = new Map<string, Surface>();
  constructor(top: number, height: number) { super(); this.top = top; this.height = height; }
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height }; }
  querySelector(selector: string) { return this.elements.get(selector) ?? null; }
}

let cleanup: void | (() => void);
let playerChanges: Array<() => void>;
beforeEach(() => {
  playerChanges = [];
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    innerHeight: 800, visualViewport: undefined,
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; }, cancelAnimationFrame: vi.fn(),
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { playerChanges.push(callback); }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('document', { body: { style: { position: '' } }, scrollingElement: null });
  vi.stubGlobal('getComputedStyle', (element: Surface) => ({ visibility: element.visibility }));
});
afterEach(() => { if (cleanup) cleanup(); cleanup = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('reader chrome painting during transitions', () => {
  it('keeps the docked header layout height stable when its zoomed controls wrap', () => {
    const header = new Surface(0, 137), root = new Surface(0, 800), shell = new Surface(53, 721);
    header.dataset.readerBarLayoutHeight = '53';
    root.elements.set('.reader-chrome-top', header);
    Object.assign(root, { querySelectorAll: () => [] });
    useReaderChromeLayout({ enabled: true, isTopDocked: true,
      rootRef: { current: root as unknown as HTMLDivElement }, shellRef: { current: shell as unknown as HTMLElement }, usesDocumentScroll: false });
    cleanup = vi.mocked(useLayoutEffect).mock.calls[0][0]();
    expect(root.properties.get('--reader-layout-top-inset')).toBe('53px');
    expect(shell.style.clipPath).toBe('');
  });
  it('leaves prose painting unchanged while controls appear and disappear', () => {
    const header = new Surface(0, 53), footer = new Surface(680, 120), status = new Surface(774, 26);
    const shell = new Surface(0, 774), root = new Surface(0, 800);
    const elements = new Map([['.reader-chrome-top', header], ['.reader-bottom-bar', footer], ['.reader-reading-status', status]]);
    Object.assign(root, { querySelector: (selector: string) => elements.get(selector), querySelectorAll: () => [] });
    useReaderChromeLayout({ enabled: true, isTopDocked: false,
      rootRef: { current: root as unknown as HTMLDivElement }, shellRef: { current: shell as unknown as HTMLElement }, usesDocumentScroll: false });
    cleanup = vi.mocked(useLayoutEffect).mock.calls[0][0]();
    expect(shell.style.clipPath).toBe('');
    expect(root.properties.get('--reader-layout-top-inset')).toBe('0px');
    expect(root.properties.get('--reader-bottom-inset')).toBe('26px');
    expect(root.properties.get('--reader-layout-bottom-inset')).toBe('26px');
    header.visibility = 'hidden'; footer.visibility = 'hidden';
    const end = new Event('transitionend'); Object.defineProperty(end, 'target', { value: footer }); root.dispatchEvent(end);
    expect(shell.style.clipPath).toBe('');
    expect(root.properties.get('--reader-layout-bottom-inset')).toBe('26px');
  });

  it('leaves enough scroll room to read the final line above the player without moving the current text', () => {
    const status = new Surface(774, 26), player = new Surface(600, 174);
    const shell = new Surface(0, 774), root = new Surface(0, 800);
    shell.scrollTop = 1000;
    shell.clientHeight = 774;
    shell.elements.set('.reader-page-surface', new Surface(-1000, 2000));
    shell.elements.set('.reader-body-text', new Surface(-900, 1800));
    root.elements.set('.reader-reading-status', status);
    root.elements.set('[aria-label="听书播放器"]', player);
    Object.assign(root, { querySelectorAll: () => [] });
    Object.defineProperty(shell, 'scrollHeight', {
      get: () => 2000 + Number.parseFloat(root.style.getPropertyValue('--reader-audiobook-tail-space') || '0'),
    });
    useReaderChromeLayout({ enabled: true, hasAudiobook: true, isTopDocked: false,
      rootRef: { current: root as unknown as HTMLDivElement }, shellRef: { current: shell as unknown as HTMLElement }, usesDocumentScroll: false });
    cleanup = vi.mocked(useLayoutEffect).mock.calls[0][0]();
    const finalLineAtEnd = () => 1900 - (shell.scrollHeight - shell.clientHeight);
    expect(finalLineAtEnd()).toBe(player.top - 12);
    expect(shell.scrollTop).toBe(1000);
    // A fixed player can move after its ResizeObserver has already fired.
    // Its new top must release trailing space without a window resize.
    player.top = 550;
    const moved = new Event(AUDIOBOOK_LAYOUT_EVENT);
    Object.defineProperty(moved, 'target', { value: player });
    root.dispatchEvent(moved);
    expect(finalLineAtEnd()).toBe(player.top - 12);
    expect(shell.scrollTop).toBe(1000);
    player.top = 500;
    const end = new Event('transitionend'); Object.defineProperty(end, 'target', { value: player }); root.dispatchEvent(end);
    expect(finalLineAtEnd()).toBe(player.top - 12);
    window.dispatchEvent(new Event('resize'));
    expect(finalLineAtEnd()).toBe(player.top - 12);
    expect(shell.scrollTop).toBe(1000);
  });

  it('uses the new player after a voice-mode switch and releases its space when removed', () => {
    const status = new Surface(774, 26), oldPlayer = new Surface(600, 174);
    const shell = new Surface(0, 774), root = new Surface(0, 800);
    shell.scrollTop = 1000;
    shell.clientHeight = 774;
    shell.elements.set('.reader-page-surface', new Surface(-1000, 2000));
    shell.elements.set('.reader-body-text', new Surface(-900, 1800));
    root.elements.set('.reader-reading-status', status);
    root.elements.set('[aria-label="听书播放器"]', oldPlayer);
    Object.assign(root, { querySelectorAll: () => [] });
    Object.defineProperty(shell, 'scrollHeight', {
      get: () => 2000 + Number.parseFloat(root.style.getPropertyValue('--reader-audiobook-tail-space') || '0'),
    });
    useReaderChromeLayout({ enabled: true, hasAudiobook: true, isTopDocked: false,
      rootRef: { current: root as unknown as HTMLDivElement }, shellRef: { current: shell as unknown as HTMLElement }, usesDocumentScroll: false });
    cleanup = vi.mocked(useLayoutEffect).mock.calls[0][0]();
    const newPlayer = new Surface(500, 274);
    oldPlayer.top = -oldPlayer.height; // A detached section has no useful screen bounds.
    root.elements.set('[aria-label="听书播放器"]', newPlayer);
    playerChanges.forEach(refresh => refresh());
    expect(1900 - (shell.scrollHeight - shell.clientHeight)).toBe(newPlayer.top - 12);
    window.dispatchEvent(new Event('resize'));
    expect(1900 - (shell.scrollHeight - shell.clientHeight)).toBe(newPlayer.top - 12);
    expect(shell.scrollTop).toBe(1000);
    root.elements.delete('[aria-label="听书播放器"]');
    playerChanges.forEach(refresh => refresh());
    expect(root.style.getPropertyValue('--reader-audiobook-tail-space')).toBe('0px');
  });
  it('does not resize the scroll range when the player moves with transient controls', () => {
    const status = new Surface(774, 26), player = new Surface(600, 174);
    player.dataset.readerPlayerReservedTop = '500';
    const shell = new Surface(0, 774), root = new Surface(0, 800);
    shell.scrollTop = 1000; shell.clientHeight = 774;
    shell.elements.set('.reader-page-surface', new Surface(-1000, 2000));
    shell.elements.set('.reader-body-text', new Surface(-900, 1800));
    root.elements.set('.reader-reading-status', status);
    root.elements.set('[aria-label="听书播放器"]', player);
    Object.assign(root, { querySelectorAll: () => [] });
    Object.defineProperty(shell, 'scrollHeight', {
      get: () => 2000 + Number.parseFloat(root.style.getPropertyValue('--reader-audiobook-tail-space') || '0'),
    });
    useReaderChromeLayout({ enabled: true, hasAudiobook: true, isTopDocked: false,
      rootRef: { current: root as unknown as HTMLDivElement }, shellRef: { current: shell as unknown as HTMLElement }, usesDocumentScroll: false });
    cleanup = vi.mocked(useLayoutEffect).mock.calls[0][0]();
    const height = shell.scrollHeight;
    for (const top of [500, 600, 500]) {
      player.top = top;
      const event = new Event(AUDIOBOOK_LAYOUT_EVENT);
      Object.defineProperty(event, 'target', { value: player }); root.dispatchEvent(event);
      expect(shell.scrollHeight).toBe(height);
      expect(shell.scrollTop).toBe(1000);
      expect(1900 - (shell.scrollHeight - shell.clientHeight)).toBeLessThanOrEqual(top - 12);
    }
  });
});
