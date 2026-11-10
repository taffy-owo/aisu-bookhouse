import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '../../books';
import { getBookById, getEditableBookChapters, invalidateBookListCache } from '../../books/services/bookService';
import { getReaderResource, getReadingProgress } from '../../reader/services/readerService';
import type { ReaderResource, ReadingProgress } from '../../reader/types/reader';
import type { WholeBookTranslationJob } from '../../uploads/services/wholeBookTranslationService';
import { createBookPublicationRefresher, getBookPublicationSnapshot, type BookPublicationSnapshot, type BookPublicationState } from './bookPublicationRefresh';

vi.mock('../../books/services/bookService', () => ({ getBookById: vi.fn(), getEditableBookChapters: vi.fn(), invalidateBookListCache: vi.fn() }));
vi.mock('../../reader/services/readerService', () => ({ getReaderResource: vi.fn(), getReadingProgress: vi.fn() }));

const original: Book = {
  id: 'book', title: '来信', author: '作者', description: '', kind: 'novel', readerType: 'epub',
  tags: [], progressPercent: 30, chapterCount: 3, isOwned: true, status: 'ready', updatedAt: '2026-10-28T01:00:00Z', createdAt: '2026-10-01',
};
const job = { id: 'job', book_id: 'book', job_kind: 'whole_book', completed_chapters: 3, status: 'processing', stage: 'draft' } as WholeBookTranslationJob;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('background publication reconciliation', () => {
  let state: BookPublicationState;
  let serverBook: Book;
  let serverResource: ReaderResource;
  let snapshots: BookPublicationSnapshot[];
  let failures: boolean[];
  let refresher: ReturnType<typeof createBookPublicationRefresher>;
  const refresh = () => refresher.refresh(new AbortController().signal);
  function publish(count = 6) {
    serverBook = { ...serverBook, chapterCount: count, updatedAt: '2026-10-28T01:00:01Z' };
    serverResource = { readerType: 'epub', chapterCount: count, toc: [], version: serverBook.updatedAt };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    serverBook = { ...original };
    serverResource = { readerType: 'epub', chapterCount: 3, toc: [], version: original.updatedAt };
    state = { bookId: 'book', sessionId: 'account', book: { ...original }, readerResource: serverResource, ready: true, busy: false, mutationRevision: 0, job: { ...job } };
    snapshots = []; failures = [];
    vi.mocked(getBookById).mockImplementation(async () => ({ ...serverBook }));
    vi.mocked(getReaderResource).mockImplementation(async () => structuredClone(serverResource));
    vi.mocked(getEditableBookChapters).mockImplementation(async () => Array.from({ length: serverBook.chapterCount ?? 0 }, (_, i) => ({ index: i + 1, title: `第${i + 1}话` })));
    vi.mocked(getReadingProgress).mockResolvedValue({ bookId: 'book', readerType: 'epub', progressPercent: 30, updatedAt: original.updatedAt });
    refresher = createBookPublicationRefresher({ bookId: 'book', sessionId: 'account' }, () => state, (snapshot) => {
      snapshots.push(snapshot); state.book = snapshot.book; state.readerResource = snapshot.readerResource;
    }, (failed) => { failures.push(failed); });
  });

  it('waits for initial content and pending actions, and rejects a mismatched view', async () => {
    for (const patch of [{ ready: false }, { busy: true }, { bookId: 'other' }, { sessionId: 'other' }, { book: { ...original, id: 'other' } }]) {
      const previous = { ...state }; Object.assign(state, patch); await refresh(); state = previous;
    }
    expect(getBookById).not.toHaveBeenCalled();
    state.job = null; await refresh();
    expect(getBookById).not.toHaveBeenCalled();
  });

  it.each(['uploading', 'processing'] as const)('follows a %s book until it becomes readable without a translation job', async (status) => {
    state.job = null;
    state.book = { ...original, status };
    serverBook = { ...original, status };
    await refresh();
    expect(getBookById).toHaveBeenCalledOnce();
    expect(getReaderResource).not.toHaveBeenCalled();

    publish();
    serverBook.status = 'ready';
    await refresh();
    expect(state.book.status).toBe('ready');
    expect(snapshots.at(-1)?.book.chapterCount).toBe(6);
    await refresh();
    expect(getBookById).toHaveBeenCalledTimes(2);
  });

  it('shows a failed parsing status even when the content version has not changed', async () => {
    state.job = null;
    state.book = { ...original, status: 'processing' };
    serverBook = { ...original, status: 'failed' };
    await refresh();
    expect(state.book.status).toBe('failed');
    expect(snapshots).toHaveLength(1);
    await refresh();
    expect(getBookById).toHaveBeenCalledOnce();
  });

  it.each([
    ['pdf', 'ready'], ['comic', 'ready'], ['image', 'ready'], ['unsupported', 'ready'],
    ['epub', 'processing'], ['epub', 'uploading'], ['epub', 'failed'],
  ] as const)('refreshes %s %s without depending on chapter editing', async (readerType, status) => {
    const book = { ...original, readerType, status };
    const version = book.updatedAt;
    const resource: ReaderResource = readerType === 'pdf' ? { readerType, version, fileUrl: '/fixture.pdf' }
      : readerType === 'comic' || readerType === 'image' ? { readerType, version, pages: [{ index: 1 }], pageCount: 1 }
      : readerType === 'unsupported' ? { readerType, version, toc: [], chapterCount: 0 }
      : { readerType, version, toc: [], chapterCount: 3 };
    vi.mocked(getReaderResource).mockResolvedValue(resource);
    vi.mocked(getEditableBookChapters).mockRejectedValue(new Error('unrelated chapter endpoint unavailable'));
    const snapshot = await getBookPublicationSnapshot({ ...book, chapterCount: readerType === 'unsupported' ? 0 : book.chapterCount }, new AbortController().signal);
    expect(snapshot.readerResource).toEqual(resource);
    expect(snapshot.editableChapterIndexes.size).toBe(0);
    expect(getEditableBookChapters).not.toHaveBeenCalled();
  });

  it('still refreshes editing controls for a ready owned text book', async () => {
    vi.mocked(getReaderResource).mockResolvedValue({ readerType: 'text', version: original.updatedAt, toc: [], chapterCount: 3 });
    const snapshot = await getBookPublicationSnapshot({ ...original, readerType: 'text' }, new AbortController().signal);
    expect(snapshot.editableChapterIndexes).toEqual(new Set([1, 2, 3]));
    expect(getEditableBookChapters).toHaveBeenCalledOnce();
  });

  it('discovers a readable prefix published after its checkpoint stopped changing', async () => {
    await refresh();
    expect(snapshots.at(-1)?.book.chapterCount).toBe(3);
    publish();
    await refresh();
    expect(snapshots.at(-1)?.book.chapterCount).toBe(6);
    expect(snapshots.at(-1)?.editableChapterIndexes).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(state.job?.completed_chapters).toBe(3);
    await refresh();
    expect(getBookById).toHaveBeenCalledTimes(3);
    expect(getReaderResource).toHaveBeenCalledTimes(2);
    expect(invalidateBookListCache).toHaveBeenCalledTimes(2);
  });

  it('refreshes final publication once and stops content requests for an unchanged completed job', async () => {
    await refresh(); publish(); state.job = { ...job, completed_chapters: 6, status: 'ready', stage: 'ready' };
    await refresh(); await refresh(); await refresh();
    expect(snapshots.at(-1)?.book.chapterCount).toBe(6);
    expect(getBookById).toHaveBeenCalledTimes(2);
  });

  it('retains the entire last edition when one read fails, then retries a stable terminal job', async () => {
    state.job = { ...job, status: 'ready' }; publish();
    vi.mocked(getEditableBookChapters).mockRejectedValueOnce(new Error('offline'));
    await refresh();
    expect(snapshots).toHaveLength(0);
    expect(state.book?.chapterCount).toBe(3);
    expect(failures).toEqual([true]);
    await refresh();
    expect(snapshots.at(-1)?.book.chapterCount).toBe(6);
    expect(failures).toEqual([true, false]);
  });

  it('does not combine book metadata and catalogue from different publication versions', async () => {
    publish(); serverResource.version = '2026-10-28T01:00:02Z';
    await refresh();
    expect(snapshots).toHaveLength(0);
    expect(failures).toEqual([true]);
    serverBook.updatedAt = serverResource.version;
    await refresh();
    expect(snapshots).toHaveLength(1);
  });

  it('retries inconsistent chapter counts even when timestamps match', async () => {
    publish(); serverResource = { ...serverResource, readerType: 'epub', chapterCount: 3, toc: [] };
    await refresh();
    expect(snapshots).toHaveLength(0);
    expect(failures).toEqual([true]);
    serverResource.chapterCount = 6; await refresh();
    expect(snapshots).toHaveLength(1);
  });

  it('ignores an old snapshot after a local action, then preserves the confirmed action on retry', async () => {
    const waiting = deferred<ReaderResource>();
    vi.mocked(getReaderResource).mockReturnValueOnce(waiting.promise);
    const running = refresh(); await vi.waitFor(() => expect(getReaderResource).toHaveBeenCalled());
    state.mutationRevision++; state.book = { ...original, favorite: true };
    waiting.resolve(serverResource); await running;
    expect(snapshots).toHaveLength(0);
    expect(failures).toHaveLength(0);
    serverBook.favorite = true; await refresh();
    expect(snapshots.at(-1)?.book.favorite).toBe(true);
  });

  it.each(['account', 'book', 'unmount'] as const)('ignores late reads after %s changes even if transport ignores abort', async (kind) => {
    const waiting = deferred<ReaderResource>(); const controller = new AbortController();
    vi.mocked(getReaderResource).mockReturnValueOnce(waiting.promise);
    const running = refresher.refresh(controller.signal); await vi.waitFor(() => expect(getReaderResource).toHaveBeenCalled());
    if (kind === 'account') state.sessionId = 'another';
    if (kind === 'book') state.bookId = 'another';
    if (kind === 'unmount') controller.abort();
    waiting.resolve(serverResource); await running;
    expect(snapshots).toHaveLength(0); expect(failures).toHaveLength(0);
  });

  it('does not show an old account failure in the next view', async () => {
    const waiting = deferred<ReadingProgress>();
    vi.mocked(getReadingProgress).mockReturnValueOnce(waiting.promise);
    const running = refresh(); await vi.waitFor(() => expect(getReadingProgress).toHaveBeenCalled());
    state.sessionId = 'another'; waiting.reject(new Error('old account error')); await running;
    expect(snapshots).toHaveLength(0); expect(failures).toHaveLength(0);
  });

  it('never lets an overlapping earlier response replace the newer edition', async () => {
    const waiting = deferred<Book | null>();
    vi.mocked(getBookById).mockReturnValueOnce(waiting.promise);
    const old = refresh(); publish(); await refresh(); waiting.resolve(original); await old;
    expect(snapshots).toHaveLength(1); expect(state.book?.chapterCount).toBe(6);
  });

  it('supports publication events with no visible job and does not consume a newer event early', async () => {
    state.job = null; refresher.invalidate();
    const waiting = deferred<Book | null>(); vi.mocked(getBookById).mockReturnValueOnce(waiting.promise);
    const running = refresh(); refresher.invalidate(); waiting.resolve(original); await running;
    await refresh(); await refresh();
    expect(getBookById).toHaveBeenCalledTimes(2);
  });

  it('updates a public book without requesting its owner-only editing endpoint', async () => {
    state.job = null; serverBook.isOwned = false; publish(); refresher.invalidate(); await refresh();
    expect(snapshots.at(-1)?.book.chapterCount).toBe(6);
    expect(snapshots.at(-1)?.editableChapterIndexes.size).toBe(0);
    expect(getEditableBookChapters).not.toHaveBeenCalled();
  });

  it('keeps a newer locally confirmed edition when the book probe arrives stale', async () => {
    state.book = { ...original, updatedAt: '2026-10-28T01:00:02Z' };
    await refresh();
    expect(getReaderResource).not.toHaveBeenCalled(); expect(snapshots).toHaveLength(0);
  });

  it('only keeps probing source updates while they can actually publish', async () => {
    state.job = { ...job, job_kind: 'source_update', stage: 'draft' };
    await refresh(); await refresh();
    expect(getBookById).toHaveBeenCalledTimes(1);
    state.job = { ...state.job, stage: 'packaging' }; await refresh(); await refresh();
    expect(getBookById).toHaveBeenCalledTimes(3);
    state.job = { ...state.job, status: 'paused' }; await refresh(); await refresh();
    expect(getBookById).toHaveBeenCalledTimes(4);
  });

  it('retains readable content when the background book probe returns not found', async () => {
    vi.mocked(getBookById).mockResolvedValueOnce(null); await refresh();
    expect(state.book).toEqual(original); expect(snapshots).toHaveLength(0); expect(failures).toEqual([true]);
    await refresh(); expect(snapshots).toHaveLength(1);
  });

  it('reconciles the real book revision while reading activity has a newer clock', async () => {
    serverBook = { ...serverBook, version: original.updatedAt, updatedAt: '2026-10-28T01:02:00Z' };
    state.book = { ...serverBook };
    await refresh();
    expect(snapshots.at(-1)?.book.version).toBe(original.updatedAt);
    expect(failures).toEqual([false]);
    // Publishing can precede the saved device clock, and must still appear.
    serverBook = { ...serverBook, chapterCount: 6, version: '2026-10-28T01:00:01Z' };
    serverResource = { readerType: 'epub', chapterCount: 6, toc: [], version: serverBook.version };
    await refresh();
    expect(snapshots.at(-1)?.book.chapterCount).toBe(6);
    expect(failures).toEqual([false, false]);
  });

  it('keeps newer metadata even if an old edition has more recent reading activity', async () => {
    state.book = { ...original, version: '2026-10-28T01:00:02Z', updatedAt: '2026-10-28T01:00:03Z' };
    serverBook = { ...original, version: original.updatedAt, updatedAt: '2026-10-28T01:02:00Z' };
    await refresh();
    expect(snapshots).toHaveLength(0);
    expect(getReaderResource).not.toHaveBeenCalled();
  });
  it('rejects an older metadata revision inside the same millisecond', async () => {
    state.book = { ...original, version: '2026-10-28T01:00:00.123457Z' };
    serverBook = { ...original, version: '2026-10-28T01:00:00.123456Z' };
    await refresh();
    expect(snapshots).toHaveLength(0);
    expect(getReaderResource).not.toHaveBeenCalled();
  });

  it('compares legacy timestamps without a suffix as UTC', async () => {
    serverBook = { ...serverBook, version: '2026-10-28T01:00:00.000000', updatedAt: '2026-10-28T01:02:00Z' };
    serverResource.version = '2026-10-28T01:00:00Z';
    await refresh();
    expect(snapshots).toHaveLength(1);
    expect(failures).toEqual([false]);
  });
  it('does not combine publications that differ only in database microseconds', async () => {
    serverBook = { ...serverBook, version: '2026-10-28T01:00:00.123456Z' };
    serverResource.version = '2026-10-28T01:00:00.123457Z';
    await refresh();
    expect(snapshots).toHaveLength(0);
    expect(failures).toEqual([true]);
    serverBook.version = '2026-10-28T01:00:00.123457';
    await refresh();
    expect(snapshots).toHaveLength(1);
    expect(failures).toEqual([true, false]);
  });
});
