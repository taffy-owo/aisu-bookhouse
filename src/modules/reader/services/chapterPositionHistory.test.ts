import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderResource, ReadingProgress } from '../types/reader';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { readChapterPosition, readChapterPositionHistory, reconcileChapterPositionReset, resolveChapterAnchor, resolveChapterPosition, resolveInitialChapterProgress, saveChapterPosition } from './chapterPositionHistory';
import type { ReaderViewportAnchor } from '../utils/readerViewportAnchor';

describe('chapterPositionHistory', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: {
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    clearAuthStorage();
    setStoredSession({ id: 'reader-1', nickname: 'Reader', role: 'user', status: 'active' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps an independent position for every chapter', () => {
    saveChapterPosition('book-1', 3, 0.52, '2026-07-10T10:00:00.000Z');
    saveChapterPosition('book-1', 4, 0.08, '2026-07-10T10:01:00.000Z');

    expect(readChapterPosition('book-1', 3)?.ratio).toBe(0.52);
    expect(readChapterPosition('book-1', 4)?.ratio).toBe(0.08);
  });

  const resetProgress: ReadingProgress = { bookId: 'reset-book', readerType: 'epub', progressPercent: 0, updatedAt: '2026-10-29T01:00:00Z' };

  it('invalidates all pre-reset chapters while retaining newer reading and other books', () => {
    saveChapterPosition('reset-book', 1, .42, '2026-10-28T01:00:00Z', 'one');
    saveChapterPosition('reset-book', 2, .64, resetProgress.updatedAt, 'two');
    saveChapterPosition('reset-book', 3, .28, '2026-10-29T02:00:00Z', 'three');
    saveChapterPosition('other-book', 1, .37, '2026-10-28T01:00:00Z', 'one');
    reconcileChapterPositionReset(resetProgress);
    expect(readChapterPosition('reset-book', 1, 'one')).toBeNull();
    expect(readChapterPosition('reset-book', 2, 'two')).toBeNull();
    expect(readChapterPosition('reset-book', 3, 'three')?.ratio).toBe(.28);
    expect(readChapterPosition('other-book', 1, 'one')?.ratio).toBe(.37);
    expect(readChapterPositionHistory()['reset-book']).toEqual({ 'chapter:three': { ratio: .28, updatedAt: '2026-10-29T02:00:00Z' } });
  });

  it('does not let a late old save revive a reset chapter', () => {
    const progress = { ...resetProgress, bookId: 'late-reset-book' };
    reconcileChapterPositionReset(progress);
    saveChapterPosition(progress.bookId, 1, .42, '2026-10-28T01:00:00Z', 'one');
    expect(readChapterPosition(progress.bookId, 1, 'one')).toBeNull();
    saveChapterPosition(progress.bookId, 1, .21, '2026-10-29T02:00:00Z', 'one');
    reconcileChapterPositionReset({ ...progress, updatedAt: '2026-10-28T01:00:00Z' });
    expect(readChapterPosition(progress.bookId, 1, 'one')?.ratio).toBe(.21);
  });

  it('keeps the reset account-scoped when local storage rejects cleanup', () => {
    const progress = { ...resetProgress, bookId: 'storage-reset-book' };
    saveChapterPosition(progress.bookId, 1, .42, '2026-10-28T01:00:00Z', 'one');
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    reconcileChapterPositionReset(progress);
    expect(readChapterPosition(progress.bookId, 1, 'one')).toBeNull();
    write.mockRestore();
    setStoredSession({ id: 'reader-2', nickname: 'Reader', role: 'user', status: 'active' });
    saveChapterPosition(progress.bookId, 1, .73, '2026-10-28T01:00:00Z', 'one');
    expect(readChapterPosition(progress.bookId, 1, 'one')?.ratio).toBe(.73);
    setStoredSession({ id: 'reader-1', nickname: 'Reader', role: 'user', status: 'active' });
    expect(readChapterPosition(progress.bookId, 1, 'one')).toBeNull();
  });

  it('honors the authoritative reset when the device clock is behind the server', () => {
    const progress = { ...resetProgress, bookId: 'clock-reset-book', updatedAt: new Date(Date.now() + 3600_000).toISOString() };
    saveChapterPosition(progress.bookId, 1, .42, new Date().toISOString(), 'one');
    reconcileChapterPositionReset(progress);
    expect(readChapterPosition(progress.bookId, 1, 'one')).toBeNull();
  });

  it.each([
    { chapterIndex: 1, epubCfi: 'aisu-scroll:0' }, { progressPercent: 100 }, { chapterHref: 'one.xhtml' },
    { epubCfi: 'aisu-scroll:0' }, { readerType: 'pdf' as const }, { readerType: 'comic' as const },
    { imageIndex: 1 }, { pageNumber: 1 }, { updatedAt: 'invalid' },
  ])('does not treat a starting position, completion, media, or invalid timestamp as a reset %j', (change) => {
    const progress = { ...resetProgress, bookId: 'not-reset-book', ...change };
    saveChapterPosition(progress.bookId, 1, .42, '2026-10-28T01:00:00Z', 'one');
    reconcileChapterPositionReset(progress);
    expect(readChapterPosition(progress.bookId, 1, 'one')?.ratio).toBe(.42);
  });

  it('uses a chapter history position when the server currently points at another chapter', () => {
    expect(resolveChapterPosition({
      chapterIndex: 3,
      localPosition: { ratio: 0.52, updatedAt: '2026-07-10T10:00:00.000Z' },
      serverChapterIndex: 4,
      serverRatio: 0,
      serverUpdatedAt: '2026-07-10T10:01:00.000Z',
    })).toBe(0.52);
  });

  it('prefers the newer position when local and server both describe the same chapter', () => {
    expect(resolveChapterPosition({
      chapterIndex: 3,
      localPosition: { ratio: 0.4, updatedAt: '2026-07-10T10:00:00.000Z' },
      serverChapterIndex: 3,
      serverRatio: 0.7,
      serverUpdatedAt: '2026-07-10T10:02:00.000Z',
    })).toBe(0.7);
  });

  it('keeps a newer local pagehide position while the server save is still pending', () => {
    expect(resolveChapterPosition({
      chapterIndex: 3,
      localPosition: { ratio: 0.46, updatedAt: '2026-07-10T10:03:00.000Z' },
      serverChapterIndex: 3,
      serverRatio: 0,
      serverUpdatedAt: '2026-07-10T10:02:00.000Z',
    })).toBe(0.46);
  });

  it('ignores malformed local entries without breaking later saves', () => {
    store.set(
      'aisu-bookhouse:chapter-position-history:reader-1',
      JSON.stringify({
        'book-1': 'corrupted',
        'book-2': {
          '1': { ratio: 'not-a-number', updatedAt: '2026-07-10T10:00:00.000Z' },
          '2': { ratio: 0.64, updatedAt: '2026-07-10T10:01:00.000Z' },
        },
      }),
    );

    expect(readChapterPosition('book-1', 1)).toBeNull();
    expect(readChapterPosition('book-2', 1)).toBeNull();
    expect(readChapterPosition('book-2', 2)?.ratio).toBe(0.64);

    expect(() => saveChapterPosition('book-3', 1, 0.2, '2026-07-10T10:02:00.000Z')).not.toThrow();
    expect(readChapterPosition('book-3', 1)?.ratio).toBe(0.2);
  });

  it('keeps a chapter position when its catalogue index changes', () => {
    saveChapterPosition('book-1', 3, .62, '2026-10-27T01:00:00Z', 'chapter-c');
    expect(readChapterPosition('book-1', 2, 'chapter-c')?.ratio).toBe(.62);
  });
  it('does not apply an old chapter position to a replacement at the same index', () => {
    saveChapterPosition('book-1', 2, .72, '2026-10-27T01:00:00Z', 'old-b');
    expect(readChapterPosition('book-1', 2, 'new-b')).toBeNull();
  });
  it('does not let a late old-edition save overwrite the new edition', () => {
    saveChapterPosition('book-1', 2, .2, '2026-10-27T01:00:00Z', 'new-b');
    saveChapterPosition('book-1', 2, .9, '2026-10-27T02:00:00Z', 'old-b');
    expect(readChapterPosition('book-1', 2, 'new-b')?.ratio).toBe(.2);
  });
  it('ignores legacy index-only positions when the current chapter has an identity', () => {
    saveChapterPosition('book-1', 2, .8);
    expect(readChapterPosition('book-1', 2, 'new-b')).toBeNull();
    expect(readChapterPosition('book-1', 2)?.ratio).toBe(.8);
  });
  it('keeps chapter identities scoped to books and accounts', () => {
    saveChapterPosition('book-1', 2, .4, undefined, 'chapter-b');
    expect(readChapterPosition('book-2', 2, 'chapter-b')).toBeNull();
    setStoredSession({ id: 'reader-2', nickname: 'Other', role: 'user' });
    expect(readChapterPosition('book-1', 2, 'chapter-b')).toBeNull();
  });

  const anchor: ReaderViewportAnchor = { blockIndex: 12, blockText: 'Same text after reflow', offsetRatio: .2, viewportOffset: 80, sourceOffset: 480, sourceViewportOffset: 84 };
  it('round trips bounded source identity and context without exposing them to another account', () => {
    const current = { ...anchor, sourceSignature: '900:abcd0123abcd0123', sourceContext: { before: '原来读到的前文。', after: '接下来要看的正文。' } };
    saveChapterPosition('source-book', 2, .4, '2026-10-29T01:00:00Z', 'two', current);
    expect(readChapterPosition('source-book', 2, 'two')?.anchor).toEqual(current);
    setStoredSession({ id: 'reader-2', nickname: 'Other', role: 'user' });
    expect(readChapterPosition('source-book', 2, 'two')).toBeNull();
  });
  it('drops malformed or oversized source context while retaining the existing reading position', () => {
    saveChapterPosition('source-book', 2, .4, '2026-10-29T01:00:00Z', 'two', {
      ...anchor, sourceSignature: 'invalid', sourceContext: { before: '文'.repeat(97), after: '正常的正文。' },
    });
    expect(readChapterPosition('source-book', 2, 'two')?.anchor).toEqual(anchor);
  });
  it('round trips the precise text position and discards it when a boundary is explicitly selected', () => {
    saveChapterPosition('book', 2, .4, '2026-10-29T01:00:00Z', 'two', anchor);
    expect(readChapterPosition('book', 2, 'two')?.anchor).toEqual(anchor);
    saveChapterPosition('book', 2, 0, '2026-10-29T01:01:00Z', 'two');
    expect(readChapterPosition('book', 2, 'two')?.anchor).toBeUndefined();
  });
  it.each([
    { blockIndex: -1 }, { blockIndex: 1.2 }, { blockText: 'x'.repeat(65) }, { offsetRatio: Number.NaN },
    { offsetRatio: 2 }, { viewportOffset: Infinity }, { viewportOffset: 1_000_000 },
  ])('retains legacy ratio recovery when an anchor is invalid: %j', (change) => {
    store.set('aisu-bookhouse:chapter-position-history:reader-1', JSON.stringify({ book: { 'chapter:two': {
      ratio: .4, updatedAt: '2026-10-29T01:00:00Z', anchor: { ...anchor, ...change },
    } } }));
    expect(readChapterPosition('book', 2, 'two')).toEqual({ ratio: .4, updatedAt: '2026-10-29T01:00:00Z' });
  });
  it('drops invalid character coordinates without losing the paragraph fallback', () => {
    saveChapterPosition('book', 2, .4, '2026-10-29T01:00:00Z', 'two', { ...anchor, sourceOffset: -2 });
    const stored = readChapterPosition('book', 2, 'two')!.anchor!;
    expect(stored.sourceOffset).toBeUndefined();
    expect(stored.blockIndex).toBe(anchor.blockIndex);
  });
  it('uses an acknowledged local text position and rejects a newer remote move even at the same ratio', () => {
    const local = { ratio: .4, updatedAt: '2026-10-29T01:00:00Z', anchor };
    expect(resolveChapterAnchor(local, .4, { chapterIndex: 2, updatedAt: local.updatedAt }, 2)).toEqual(anchor);
    expect(resolveChapterAnchor(local, .4, { chapterIndex: 2, updatedAt: '2026-10-29T01:01:00Z' }, 2)).toBeNull();
    expect(resolveChapterAnchor(local, .6, { chapterIndex: 2, updatedAt: local.updatedAt }, 2)).toBeNull();
    expect(resolveChapterAnchor({ ...local, updatedAt: 'invalid' }, .4)).toBeNull();
    expect(resolveChapterAnchor(null, .4)).toBeNull();
  });
  it('keeps historical text positions independent of the current remote chapter', () => {
    const local = { ratio: .4, updatedAt: '2026-10-29T01:00:00Z', anchor };
    expect(resolveChapterAnchor(local, .4, { chapterIndex: 3, updatedAt: '2026-10-29T01:01:00Z' }, 2)).toEqual(anchor);
  });
  it('bounds growing history while retaining the newest precise position and older ratio fallbacks', () => {
    const history = Object.fromEntries(Array.from({ length: 12 }, (_, book) => [`book-${book}`, Object.fromEntries(
      Array.from({ length: 400 }, (_, chapter) => [`chapter:${chapter}`, {
        ratio: .4, updatedAt: '2026-10-01T01:00:00Z', anchor: { ...anchor, blockText: '文'.repeat(64) },
      }]),
    )]));
    const key = 'aisu-bookhouse:chapter-position-history:reader-1';
    store.set(key, JSON.stringify(history));
    saveChapterPosition('latest-book', 1, .7, '2026-10-29T01:00:00Z', 'latest-chapter', anchor);
    expect(store.get(key)!.length).toBeLessThanOrEqual(1_000_000);
    expect(readChapterPosition('latest-book', 1, 'latest-chapter')?.anchor).toEqual(anchor);
    expect(readChapterPosition('book-0', 1, '0')).toEqual({ ratio: .4, updatedAt: '2026-10-01T01:00:00Z' });
    expect(readChapterPosition('book-11', 1, '399')?.anchor).toBeDefined();
  });
  it('retains recent chapters when ratio-only history itself exceeds the storage budget', () => {
    const history = Object.fromEntries(Array.from({ length: 80 }, (_, book) => [`book-${book}`, Object.fromEntries(
      Array.from({ length: 400 }, (_, chapter) => [`chapter:${chapter}`, {
        ratio: .4, updatedAt: '2026-10-01T01:00:00Z',
      }]),
    )]));
    const key = 'aisu-bookhouse:chapter-position-history:reader-1';
    store.set(key, JSON.stringify(history));
    saveChapterPosition('latest-book', 1, .7, '2026-10-29T01:00:00Z', 'latest-chapter', anchor);
    expect(store.get(key)!.length).toBeLessThanOrEqual(1_000_000);
    expect(readChapterPosition('latest-book', 1, 'latest-chapter')?.anchor).toEqual(anchor);
  });
});


describe('pending chapter resume', () => {
  const resource: ReaderResource = { readerType: 'epub', chapterCount: 3, toc: [
    { index: 1, title: 'One', positionKey: 'one' }, { index: 2, title: 'Two', positionKey: 'two' },
  ] };
  const server: ReadingProgress = { bookId: 'book', readerType: 'epub', chapterIndex: 1, epubCfi: 'aisu-scroll:0', progressPercent: 0, updatedAt: '2026-01-01T00:00:00Z' };
  const pending: ReadingProgress = { ...server, chapterIndex: 2, positionKey: 'two', epubCfi: 'aisu-scroll:0.43', progressPercent: 48, updatedAt: '2026-01-01T00:01:00Z' };
  it('resumes the newer unsynced chapter and its position together', () => {
    expect(resolveInitialChapterProgress(resource, server, pending)).toBe(pending);
  });
  it('recalculates an old finished percentage after append without losing the local chapter position', () => {
    const expanded: ReaderResource = { readerType: 'epub', chapterCount: 198, toc: Array.from({ length: 198 }, (_, i) => ({
      index: i + 1, title: `第${i + 1}话`, positionKey: `key-${i + 1}`, progressWeight: i < 120 ? 1000 : 1800,
    })) };
    const old = { ...pending, chapterIndex: 121, positionKey: 'key-121', epubCfi: 'aisu-scroll:0.16', progressPercent: 100 };
    expect(resolveInitialChapterProgress(expanded, server, old)).toEqual({ ...old, progressPercent: 46 });
    expect(old.progressPercent).toBe(100);
    const explicit = { ...server, progressPercent: 100 };
    expect(resolveInitialChapterProgress(expanded, explicit, null)).toBe(explicit);
  });
  it('does not round a pending position to finished until the last chapter actually ends', () => {
    const current = { ...resource, toc: [...resource.toc, { index: 3, title: 'Three', positionKey: 'three' }] };
    const nearEnd = { ...pending, chapterIndex: 3, positionKey: 'three', epubCfi: 'aisu-scroll:0.999', progressPercent: 100 };
    expect(resolveInitialChapterProgress(current, server, nearEnd).progressPercent).toBe(99);
    expect(resolveInitialChapterProgress(current, server, { ...nearEnd, epubCfi: 'aisu-scroll:1' }).progressPercent).toBe(100);
  });
  it.each([
    { bookId: 'other' }, { positionKey: 'replaced-chapter' }, { positionKey: undefined },
    { chapterIndex: 9 }, { chapterIndex: 1.5 }, { readerType: 'text' as const },
    { epubCfi: undefined }, { epubCfi: 'invalid' }, { imageIndex: 1 }, { pageNumber: 2 },
    { updatedAt: 'invalid' }, { updatedAt: server.updatedAt }, { updatedAt: '2025-12-31T23:59:00Z' },
  ])('rejects stale or mismatched pending progress %j', (change) => {
    expect(resolveInitialChapterProgress(resource, server, { ...pending, ...change })).toBe(server);
  });
  it('rejects a future clock outlier and media resources', () => {
    expect(resolveInitialChapterProgress(resource, server, { ...pending, updatedAt: new Date(Date.now() + 3600_000).toISOString() })).toBe(server);
    expect(resolveInitialChapterProgress({ readerType: 'pdf' }, server, pending)).toBe(server);
    expect(resolveInitialChapterProgress(resource, server, null)).toBe(server);
  });
});
