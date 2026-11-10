import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderViewportAnchor } from '../utils/readerViewportAnchor';

type History = typeof import('./chapterPositionHistory');
const oldTime = '2026-11-01T00:00:00.000Z';
const newTime = '2026-11-01T00:01:00.000Z';
const anchor = (text: string): ReaderViewportAnchor => ({ blockIndex: 5, blockText: text, offsetRatio: .2, viewportOffset: 80 });

async function tab(): Promise<History> {
  vi.resetModules();
  return import('./chapterPositionHistory');
}

describe('chapter history shared by independent tabs', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not let a delayed older anchor overwrite a newer reading sentence', async () => {
    const a = await tab(), b = await tab();
    b.saveChapterPosition('book', 1, .7, newTime, 'one', anchor('new sentence'));
    a.saveChapterPosition('book', 1, .2, oldTime, 'one', anchor('old sentence'));
    expect((await tab()).readChapterPosition('book', 1, 'one')).toEqual({ ratio: .7, updatedAt: newTime, anchor: anchor('new sentence') });
  });

  it.each([false, true])('preserves interleaved writes to distinct positions (different books: %s)', async (differentBooks) => {
    const a = await tab(), b = await tab();
    const storage = window.localStorage, write = storage.setItem;
    let interleaved = false;
    storage.setItem = (key, value) => {
      if (!interleaved && key.startsWith('aisu-bookhouse:chapter-')) {
        interleaved = true;
        b.saveChapterPosition(differentBooks ? 'other' : 'book', 2, .7, newTime, 'two', anchor('second sentence'));
      }
      write(key, value);
    };
    a.saveChapterPosition('book', 1, .2, oldTime, 'one', anchor('first sentence'));
    const reopened = await tab();
    expect(interleaved).toBe(true);
    expect(reopened.readChapterPosition('book', 1, 'one')?.anchor).toEqual(anchor('first sentence'));
    expect(reopened.readChapterPosition(differentBooks ? 'other' : 'book', 2, 'two')?.anchor).toEqual(anchor('second sentence'));
  });

  it('persists an unread reset so another old tab cannot revive prior chapter positions', async () => {
    const a = await tab(), b = await tab();
    b.saveChapterPosition('book', 1, .7, oldTime, 'one', anchor('before reset'));
    a.reconcileChapterPositionReset({ bookId: 'book', readerType: 'epub', progressPercent: 0, updatedAt: newTime });
    b.saveChapterPosition('book', 1, .2, oldTime, 'one', anchor('late before reset'));
    expect((await tab()).readChapterPosition('book', 1, 'one')).toBeNull();
  });

  it('keeps post-reset reading when another tab later replays an older reset', async () => {
    const a = await tab(), b = await tab();
    a.reconcileChapterPositionReset({ bookId: 'book', readerType: 'epub', progressPercent: 0, updatedAt: newTime });
    const readAt = '2026-11-01T00:02:00.000Z';
    b.saveChapterPosition('book', 1, .3, readAt, 'one', anchor('rereading'));
    a.reconcileChapterPositionReset({ bookId: 'book', readerType: 'epub', progressPercent: 0, updatedAt: oldTime });
    expect((await tab()).readChapterPosition('book', 1, 'one')).toEqual({ ratio: .3, updatedAt: readAt, anchor: anchor('rereading') });
  });

  it('accepts a corrected sentence anchor at the same reading time after a content revision', async () => {
    const a = await tab(), b = await tab();
    a.saveChapterPosition('book', 1, .4, oldTime, 'one', anchor('before revision'));
    b.saveChapterPosition('book', 1, .5, oldTime, 'one', anchor('same sentence after revision'));
    expect((await tab()).readChapterPosition('book', 1, 'one')).toEqual({
      ratio: .5, updatedAt: oldTime, anchor: anchor('same sentence after revision'),
    });
  });

  it('observes peer changes to warmed journal rows without waiting for a storage event', async () => {
    const a = await tab();
    a.saveChapterPosition('book', 1, .4, oldTime, 'one', anchor('first sentence'));
    expect(a.readChapterPosition('book', 1, 'one')?.ratio).toBe(.4);
    const storage = window.localStorage;
    const key = Array.from({ length: storage.length }, (_, index) => storage.key(index)!)
      .find(key => key.startsWith('aisu-bookhouse:chapter-history-v2:'))!;
    const row = JSON.parse(storage.getItem(key)!);
    storage.setItem(key, JSON.stringify({ ...row, entry: { ratio: .7, updatedAt: newTime, anchor: anchor('peer sentence') } }));
    expect(a.readChapterPosition('book', 1, 'one')).toEqual({ ratio: .7, updatedAt: newTime, anchor: anchor('peer sentence') });
    storage.removeItem(key);
    expect(a.readChapterPosition('book', 1, 'one')).toBeNull();
    storage.setItem(key, JSON.stringify(row));
    expect(a.readChapterPosition('book', 1, 'one')?.ratio).toBe(.4);
  });

  it('observes a changed legacy map before a peer storage event', async () => {
    const a = await tab(), key = 'aisu-bookhouse:chapter-position-history';
    window.localStorage.setItem(key, JSON.stringify({ book: { 'chapter:one': { ratio: .4, updatedAt: oldTime } } }));
    expect(a.readChapterPosition('book', 1, 'one')?.ratio).toBe(.4);
    window.localStorage.setItem(key, JSON.stringify({ book: { 'chapter:one': { ratio: .7, updatedAt: newTime } } }));
    expect(a.readChapterPosition('book', 1, 'one')?.ratio).toBe(.7);
    window.localStorage.removeItem(key);
    expect(a.readChapterPosition('book', 1, 'one')).toBeNull();
  });

  it.each(['legacy', 'journal'])('returns detached sentences and contexts from %s history', async (format) => {
    const a = await tab();
    const precise = { ...anchor('saved sentence'), sourceOffset: 300, sourceViewportOffset: 80,
      sourceSignature: '1000:abcd0123abcd0123', sourceContext: { before: '前文', after: '后文' } };
    const entry = { ratio: .4, updatedAt: oldTime, anchor: precise };
    if (format === 'legacy') window.localStorage.setItem('aisu-bookhouse:chapter-position-history', JSON.stringify({ book: { 'chapter:one': entry } }));
    else a.saveChapterPosition('book', 1, .4, oldTime, 'one', precise);
    const position = a.readChapterPosition('book', 1, 'one')!;
    position.ratio = .9;
    position.anchor!.blockText = 'changed';
    position.anchor!.sourceContext!.after = 'changed';
    const history = a.readChapterPositionHistory();
    expect(history.book['chapter:one']).toEqual(entry);
    history.book['chapter:one'].anchor!.sourceContext!.before = 'changed';
    delete history.book['chapter:one'];
    expect(a.readChapterPosition('book', 1, 'one')).toEqual(entry);
  });

  it('preserves an acknowledged anchor when storage rejects its replacement', async () => {
    const a = await tab();
    a.saveChapterPosition('book', 1, .4, oldTime, 'one', anchor('acknowledged'));
    const write = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    a.saveChapterPosition('book', 1, .7, newTime, 'one', anchor('unsaved'));
    window.localStorage.setItem = write;
    expect((await tab()).readChapterPosition('book', 1, 'one')?.anchor).toEqual(anchor('acknowledged'));
  });

  it('isolates durable resets and anchors between accounts', async () => {
    const a = await tab();
    window.localStorage.setItem('aisu-bookhouse:session', JSON.stringify({ id: 'reader-a', nickname: 'A', role: 'user' }));
    a.saveChapterPosition('book', 1, .4, oldTime, 'one', anchor('reader a'));
    window.localStorage.setItem('aisu-bookhouse:session', JSON.stringify({ id: 'reader-b', nickname: 'B', role: 'user' }));
    a.reconcileChapterPositionReset({ bookId: 'book', readerType: 'epub', progressPercent: 0, updatedAt: newTime });
    expect((await tab()).readChapterPosition('book', 1, 'one')).toBeNull();
    window.localStorage.setItem('aisu-bookhouse:session', JSON.stringify({ id: 'reader-a', nickname: 'A', role: 'user' }));
    expect((await tab()).readChapterPosition('book', 1, 'one')?.anchor).toEqual(anchor('reader a'));
  });

  it.each([6, 12])('bounds physical storage with %i books of journal entries while preserving recent reading', async (books) => {
    const a = await tab();
    const { appendChapterHistoryRow } = await import('./chapterHistoryStorage');
    const scope = 'aisu-bookhouse:chapter-position-history';
    const precise: ReaderViewportAnchor = { ...anchor('文'.repeat(64)), sourceOffset: 300, sourceViewportOffset: 80,
      sourceSignature: '1000:abcd0123abcd0123', sourceContext: { before: '前'.repeat(96), after: '后'.repeat(96) } };
    for (let book = 0; book < books; book++) for (let chapter = 1; chapter <= 399; chapter++) {
      appendChapterHistoryRow(scope, { kind: 'position', bookId: `book-${book}`, chapterKey: `chapter:key-${chapter}`,
        entry: { ratio: .4, updatedAt: new Date(Date.parse(oldTime) + book * 1000 + chapter).toISOString(), anchor: precise } });
    }
    a.saveChapterPosition('latest', 1, .7, newTime, 'one', precise);
    const storage = window.localStorage;
    const physicalSize = Array.from({ length: storage.length }, (_, i) => storage.key(i)!)
      .reduce((sum, key) => sum + key.length + (storage.getItem(key)?.length ?? 0), 0);
    expect(physicalSize).toBeLessThanOrEqual(1_000_000);
    expect(a.readChapterPosition('latest', 1, 'one')?.anchor).toEqual(precise);
    expect(a.readChapterPosition(`book-${books - 1}`, 399, 'key-399')?.ratio).toBe(.4);
    if (books === 6) {
      expect(a.readChapterPosition(`book-${books - 1}`, 399, 'key-399')?.anchor).toEqual(precise);
      expect(a.readChapterPosition('book-0', 1, 'key-1')?.ratio).toBe(.4);
      expect(a.readChapterPosition('book-0', 1, 'key-1')?.anchor).toBeUndefined();
    } else expect(a.readChapterPosition('book-0', 1, 'key-1')).toBeNull();
  });
});
