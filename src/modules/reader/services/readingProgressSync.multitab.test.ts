import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveReadingProgress } from './readerService';
import type { ReadingProgress } from '../types/reader';

vi.mock('./readerService', () => ({ saveReadingProgress: vi.fn().mockResolvedValue(undefined) }));

type Tab = typeof import('./readingProgressSync');
const tabs: Tab[] = [];
const saved = vi.mocked(saveReadingProgress);

async function openTab() {
  vi.resetModules();
  const tab = await import('./readingProgressSync');
  tabs.push(tab);
  tab.getPendingReadingProgressSyncCount();
  return tab;
}

function progress(bookId: string, percent: number, seconds = percent): ReadingProgress {
  return { bookId, chapterIndex: 1, epubCfi: `aisu-scroll:${percent / 100}`, progressPercent: percent,
    readerType: 'epub', updatedAt: new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString() };
}

describe('reading progress shared by independent tabs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saved.mockReset();
    saved.mockResolvedValue(undefined);
    const values = new Map<string, string>();
    const target = new EventTarget();
    vi.stubGlobal('window', Object.assign(target, { localStorage: {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } }));
  });

  afterEach(() => {
    for (const tab of tabs.splice(0)) tab.resetReadingProgressSyncState();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retains different offline books when a second tab already hydrated an empty queue', async () => {
    const a = await openTab(), b = await openTab();
    await a.queueReadingProgressSync('a', progress('a', 20));
    await b.queueReadingProgressSync('b', progress('b', 30));
    const reopened = await openTab();
    expect(reopened.getPendingReadingProgress('a')).toEqual(progress('a', 20));
    expect(reopened.getPendingReadingProgress('b')).toEqual(progress('b', 30));
  });

  it('does not erase a newer shared position when an older request is acknowledged', async () => {
    const a = await openTab();
    await a.queueReadingProgressSync('a', progress('a', 20));
    let acknowledge!: () => void;
    saved.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const flushing = a.flushReadingProgressSync('a');
    await vi.advanceTimersByTimeAsync(0);
    const b = await openTab();
    await b.queueReadingProgressSync('a', progress('a', 60));
    acknowledge();
    await flushing;
    const reopened = await openTab();
    expect(reopened.getPendingReadingProgress('a')).toEqual(progress('a', 60));
  });

  it('keeps the later reading action when a stale tab writes an earlier action afterwards', async () => {
    const a = await openTab(), b = await openTab();
    await b.queueReadingProgressSync('a', progress('a', 60));
    await a.queueReadingProgressSync('a', progress('a', 20));
    const reopened = await openTab();
    expect(reopened.getPendingReadingProgress('a')).toEqual(progress('a', 60));
  });

  it('retains a new content revision with the same reading time after the old revision is acknowledged', async () => {
    const a = await openTab();
    const old = { ...progress('a', 20), contentVersion: 'old-prose', positionKey: 'same-chapter' };
    await a.queueReadingProgressSync('a', old);
    let acknowledge!: () => void;
    saved.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const flushing = a.flushReadingProgressSync('a');
    await vi.advanceTimersByTimeAsync(0);
    const b = await openTab();
    const revised = { ...old, contentVersion: 'new-prose' };
    await b.queueReadingProgressSync('a', revised);
    acknowledge();
    await flushing;
    const reopened = await openTab();
    expect(reopened.getPendingReadingProgress('a')).toEqual(revised);
  });

  it.each([false, true])('preserves interleaved browser-process writes (same book: %s)', async (sameBook) => {
    const a = await openTab(), b = await openTab();
    const storage = window.localStorage, write = storage.setItem;
    let interleaved = false;
    storage.setItem = (key, value) => {
      if (!interleaved && key.includes('progress-queue-v2')) {
        interleaved = true;
        void b.queueReadingProgressSync(sameBook ? 'a' : 'b', progress(sameBook ? 'a' : 'b', 60));
      }
      write(key, value);
    };
    await a.queueReadingProgressSync('a', progress('a', 20));
    const reopened = await openTab();
    expect(interleaved).toBe(true);
    expect(reopened.getPendingReadingProgress('a')).toEqual(progress('a', sameBook ? 60 : 20));
    if (!sameBook) expect(reopened.getPendingReadingProgress('b')).toEqual(progress('b', 60));
  });

  it('updates another open tab from storage events and clears its obsolete retry after acknowledgement', async () => {
    const a = await openTab(), b = await openTab();
    await b.queueReadingProgressSync('a', progress('a', 60));
    window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(a.getPendingReadingProgress('a')).toEqual(progress('a', 60));
    await b.flushReadingProgressSync('a');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(a.getPendingReadingProgress('a')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('does not let another account read or acknowledge the original account queue', async () => {
    const session = (id: string) => window.localStorage.setItem('aisu-bookhouse:session', JSON.stringify({ id, nickname: id, role: 'user' }));
    session('original');
    const a = await openTab();
    await a.queueReadingProgressSync('a', progress('a', 20));
    session('other');
    const b = await openTab();
    expect(b.getPendingReadingProgressSyncCount()).toBe(0);
    await b.queueReadingProgressSync('a', progress('a', 60));
    await b.flushReadingProgressSync('a');
    session('original');
    const reopened = await openTab();
    expect(reopened.getPendingReadingProgress('a')).toEqual(progress('a', 20));
  });

  it('keeps the durable queue bounded while coalescing a long offline reading session', async () => {
    const a = await openTab();
    for (let index = 0; index < 500; index++) await a.queueReadingProgressSync('a', progress('a', index % 99, index));
    const count = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
      .filter((key) => key?.includes('progress-queue-v2')).length;
    expect(count).toBe(1);
    const reopened = await openTab();
    expect(reopened.getPendingReadingProgress('a')).toEqual(progress('a', 4, 499));
  });

  it('adopts a same-time revision from another tab after a local quota failure', async () => {
    const a = await openTab();
    const original = { ...progress('a', 20), contentVersion: 'original' };
    await a.queueReadingProgressSync('a', original);
    const storage = window.localStorage, write = storage.setItem;
    storage.setItem = (key, value) => { if (key.includes('progress-queue-v2')) throw new Error('Quota'); write(key, value); };
    await a.queueReadingProgressSync('a', { ...original, progressPercent: 21 });
    storage.setItem = write;
    const b = await openTab();
    const revised = { ...original, contentVersion: 'new-prose', epubCfi: 'aisu-scroll:0.18' };
    await b.queueReadingProgressSync('a', revised);
    window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(a.getPendingReadingProgress('a')).toEqual(revised);
    await a.flushReadingProgressSync('a');
    expect(saved).toHaveBeenLastCalledWith('a', revised, expect.anything());
    expect((await openTab()).getPendingReadingProgress('a')).toBeNull();
  });
});
