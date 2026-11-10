import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../shared/api')>(),
  apiRequest: vi.fn(),
  isBackendApiEnabled: () => true,
}));

import { createChapterEditor } from './chapterEditor';
import { apiRequest, clearAuthStorage, setStoredSession } from '../../../shared/api';
import { getReaderChapter, getReaderResource, getReaderStartup, prefetchReaderChapter, prefetchReaderChapters, resetReaderChapterCache } from './readerService';

const apiRequestMock = vi.mocked(apiRequest);

function chapterPayload(index: number) {
  return { blocks: undefined, content: `chapter ${index}`, index, title: `第 ${index} 章` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const resourcePayload = (version: string) => ({ version, reader_type: 'text', chapter_count: 3, page_count: null, pages: [], toc: [], cover_url: null, file_url: null });

describe('reader chapter cache', () => {
  beforeEach(() => {
    resetReaderChapterCache();
    apiRequestMock.mockReset();
    apiRequestMock.mockImplementation((path: string) => {
      const index = Number(path.split('/').pop());
      return Promise.resolve(chapterPayload(index));
    });
  });

  afterEach(() => {
    resetReaderChapterCache();
    clearAuthStorage();
  });

  it('does not reuse private chapter content after switching accounts', async () => {
    setStoredSession({ id: 'reader-a', nickname: 'A', role: 'user' });
    await getReaderChapter('book-1', 3);
    setStoredSession({ id: 'reader-b', nickname: 'B', role: 'user' });
    await getReaderChapter('book-1', 3);
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('serves a chapter from cache on the second request', async () => {
    const first = await getReaderChapter('book-1', 3);
    const second = await getReaderChapter('book-1', 3);

    expect(first.content).toBe('chapter 3');
    expect(second).toEqual(first);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it('lets a prefetched chapter resolve without a second network call', async () => {
    prefetchReaderChapter('book-1', 5);
    await Promise.resolve();
    const chapter = await getReaderChapter('book-1', 5);

    expect(chapter.content).toBe('chapter 5');
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes a concurrent get and prefetch of the same chapter', async () => {
    prefetchReaderChapter('book-1', 7);
    const chapter = await getReaderChapter('book-1', 7);

    expect(chapter.content).toBe('chapter 7');
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it('prefetches multiple chapters sequentially so the next chapter keeps priority', async () => {
    const resolvers = new Map<number, (chapter: ReturnType<typeof chapterPayload>) => void>();
    apiRequestMock.mockImplementation((path: string) => {
      const index = Number(path.split('/').pop());
      return new Promise((resolve) => resolvers.set(index, resolve));
    });

    const prefetch = prefetchReaderChapters('book-1', [2, 3, 4]);
    await vi.waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenLastCalledWith('/books/book-1/reader/chapters/2', { signal: undefined });

    resolvers.get(2)?.(chapterPayload(2));
    await vi.waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));
    expect(apiRequestMock).toHaveBeenLastCalledWith('/books/book-1/reader/chapters/3', { signal: undefined });

    resolvers.get(3)?.(chapterPayload(3));
    await vi.waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(3));
    expect(apiRequestMock).toHaveBeenLastCalledWith('/books/book-1/reader/chapters/4', { signal: undefined });
    resolvers.get(4)?.(chapterPayload(4));
    await prefetch;
  });

  it('evicts the oldest chapter past the cache limit', async () => {
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      await getReaderChapter('book-1', index);
    }
    apiRequestMock.mockClear();

    // Chapter 1 was evicted (limit 8) and must refetch; chapter 9 is still cached.
    await getReaderChapter('book-1', 1);
    await getReaderChapter('book-1', 9);

    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a pre-reset foreground response replace fresh cached content', async () => {
    const old = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...chapterPayload(2), content: 'new chapter' });
    const pending = getReaderChapter('book-1', 2);
    resetReaderChapterCache();
    await getReaderChapter('book-1', 2);
    old.resolve({ ...chapterPayload(2), content: 'old chapter' });
    await pending;
    expect((await getReaderChapter('book-1', 2)).content).toBe('new chapter');
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('does not let an old prefetch delete or overwrite a newer pending prefetch', async () => {
    const old = deferred<ReturnType<typeof chapterPayload>>();
    const next = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = prefetchReaderChapter('book-1', 2);
    resetReaderChapterCache();
    const second = prefetchReaderChapter('book-1', 2);
    old.resolve({ ...chapterPayload(2), content: 'old chapter' });
    await first;
    const needed = getReaderChapter('book-1', 2);
    next.resolve({ ...chapterPayload(2), content: 'new chapter' });
    expect((await needed).content).toBe('new chapter');
    await second;
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('stops an obsolete sequential warmup after a cache reset', async () => {
    const old = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise);
    const pending = prefetchReaderChapters('book-1', [2, 3, 4]);
    resetReaderChapterCache();
    old.resolve(chapterPayload(2));
    await pending;
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached chapters when a newer resource version is observed', async () => {
    apiRequestMock.mockResolvedValueOnce(resourcePayload('2026-10-27T01:00:00Z'));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    apiRequestMock.mockResolvedValueOnce(resourcePayload('2026-10-27T02:00:00Z'));
    await getReaderResource('book-1');
    apiRequestMock.mockResolvedValueOnce({ ...chapterPayload(2), content: 'published revision' });
    expect((await getReaderChapter('book-1', 2)).content).toBe('published revision');
  });

  it('can reset one book without evicting a different book', async () => {
    await getReaderChapter('book-1', 2);
    await getReaderChapter('book-2', 2);
    resetReaderChapterCache('book-1');
    apiRequestMock.mockClear();
    await getReaderChapter('book-1', 2);
    await getReaderChapter('book-2', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith('/books/book-1/reader/chapters/2', { signal: undefined });
  });

  it('does not cache a foreground response after its consumer has aborted', async () => {
    const old = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise);
    const controller = new AbortController();
    const pending = getReaderChapter('book-1', 2, controller.signal);
    controller.abort();
    old.resolve(chapterPayload(2));
    await pending;
    await getReaderChapter('book-1', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('keeps chapters cached when the resource version has not changed', async () => {
    apiRequestMock.mockResolvedValueOnce(resourcePayload('same-version'));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    apiRequestMock.mockResolvedValueOnce(resourcePayload('same-version'));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(3);
  });

  it('refreshes an already waiting foreground reader after resource invalidation', async () => {
    apiRequestMock.mockResolvedValueOnce(resourcePayload('v1'));
    await getReaderResource('book-1');
    const old = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise);
    const pending = getReaderChapter('book-1', 2);
    apiRequestMock.mockResolvedValueOnce(resourcePayload('v2'));
    await getReaderResource('book-1');
    apiRequestMock.mockResolvedValueOnce({ ...chapterPayload(2), content: 'new edition' });
    old.resolve({ ...chapterPayload(2), content: 'old edition' });
    expect((await pending).content).toBe('new edition');
    expect(apiRequestMock).toHaveBeenCalledTimes(4);
  });

  it('recovers an invalidated foreground request even if the old request fails', async () => {
    let reject!: (error: Error) => void;
    apiRequestMock.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const pending = getReaderChapter('book-1', 2);
    resetReaderChapterCache('book-1');
    apiRequestMock.mockResolvedValueOnce({ ...chapterPayload(2), content: 'new edition' });
    reject(new Error('old file unavailable'));
    expect((await pending).content).toBe('new edition');
  });

  it('uses startup resource versions to invalidate an earlier edition', async () => {
    apiRequestMock.mockResolvedValueOnce(resourcePayload('v1'));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    apiRequestMock.mockResolvedValueOnce({
      book: { id: 'book-1' }, chapter: chapterPayload(1), marks: [],
      progress: { book_id: 'book-1', reader_type: 'text', progress_percent: 0 }, resource: resourcePayload('v2'),
    });
    await getReaderStartup('book-1');
    apiRequestMock.mockResolvedValueOnce({ ...chapterPayload(2), content: 'startup edition' });
    expect((await getReaderChapter('book-1', 2)).content).toBe('startup edition');
  });

  it.each([
    ['2026-10-27T02:00:00Z', '2026-10-27T01:00:00Z'],
    ['2026-11-08T07:00:00.123900Z', '2026-11-08T07:00:00.123800Z'],
  ])('ignores an older resource response after observing %s', async (newer, older) => {
    apiRequestMock.mockResolvedValueOnce(resourcePayload(newer));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    apiRequestMock.mockResolvedValueOnce(resourcePayload(older));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(3);
  });

  it('does not invalidate a current edition with an aborted resource response', async () => {
    apiRequestMock.mockResolvedValueOnce(resourcePayload('v1'));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    const controller = new AbortController();
    controller.abort();
    apiRequestMock.mockResolvedValueOnce(resourcePayload('v2'));
    await getReaderResource('book-1', controller.signal);
    await getReaderChapter('book-1', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(3);
  });

  it('invalidates unversioned resources when the catalogue changes', async () => {
    apiRequestMock.mockResolvedValueOnce(resourcePayload(''));
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    apiRequestMock.mockResolvedValueOnce({ ...resourcePayload(''), chapter_count: 2 });
    await getReaderResource('book-1');
    await getReaderChapter('book-1', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(4);
  });

  it('keeps an unrelated warmup running after a book-scoped reset', async () => {
    const old = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise);
    const pending = prefetchReaderChapters('book-2', [2, 3]);
    resetReaderChapterCache('book-1');
    old.resolve(chapterPayload(2));
    await pending;
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('stops sequential warmup requests after switching accounts', async () => {
    setStoredSession({ id: 'reader-a', nickname: 'A', role: 'user' });
    const old = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise);
    const pending = prefetchReaderChapters('book-1', [2, 3, 4]);
    setStoredSession({ id: 'reader-b', nickname: 'B', role: 'user' });
    old.resolve(chapterPayload(2));
    await pending;
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not discard another account cache on a scoped reset', async () => {
    setStoredSession({ id: 'reader-a', nickname: 'A', role: 'user' });
    await getReaderChapter('book-1', 2);
    setStoredSession({ id: 'reader-b', nickname: 'B', role: 'user' });
    await getReaderChapter('book-1', 2);
    resetReaderChapterCache('book-1');
    setStoredSession({ id: 'reader-a', nickname: 'A', role: 'user' });
    await getReaderChapter('book-1', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a recently read chapter in the LRU when another chapter is added', async () => {
    for (let index = 1; index <= 8; index++) await getReaderChapter('book-1', index);
    await getReaderChapter('book-1', 1);
    await getReaderChapter('book-1', 9);
    apiRequestMock.mockClear();
    await getReaderChapter('book-1', 1);
    await getReaderChapter('book-1', 2);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenLastCalledWith('/books/book-1/reader/chapters/2', { signal: undefined });
  });

  it('keeps a saved chapter current when an older prefetch finishes after the editor', async () => {
    await getReaderChapter('book-2', 2);
    const old = deferred<ReturnType<typeof chapterPayload>>();
    apiRequestMock.mockReturnValueOnce(old.promise);
    const pending = prefetchReaderChapter('book-1', 2);
    const reset = vi.fn(resetReaderChapterCache);
    const editor = createChapterEditor('book-1', {
      getEditableBookChapter: async () => ({ ...chapterPayload(2), format: 'text', hasImages: false, revision: 'a'.repeat(64) }),
      updateBookChapter: async () => ({ chapterCount: 3, index: 2, textLength: 20, title: 'saved title' }),
      deleteBookChapter: async () => ({ chapterCount: 2, deletedIndex: 2 }),
      getReaderChapter, getReaderResource, resetReaderChapterCache: reset,
    });
    await editor.open(2);
    apiRequestMock.mockResolvedValueOnce({ ...chapterPayload(2), content: 'saved body' }).mockResolvedValueOnce(resourcePayload('v2'));
    const onSaved = vi.fn();
    await editor.save({ content: 'saved body', title: 'saved title' }, onSaved);
    expect(reset).toHaveBeenCalledWith('book-1');
    expect(onSaved.mock.calls[0]?.[0].content).toBe('saved body');
    old.resolve({ ...chapterPayload(2), content: 'pre-edit body' });
    await pending;
    apiRequestMock.mockClear();
    expect((await getReaderChapter('book-1', 2)).content).toBe('saved body');
    await getReaderChapter('book-2', 2);
    expect(apiRequestMock).not.toHaveBeenCalled();
    editor.invalidate();
  });

  it('drops reindexed cached chapters after deletion without discarding another book', async () => {
    await getReaderChapter('book-1', 2);
    await getReaderChapter('book-2', 2);
    const reset = vi.fn(resetReaderChapterCache);
    const editor = createChapterEditor('book-1', {
      getEditableBookChapter: async () => ({ ...chapterPayload(2), format: 'epub', hasImages: false, revision: 'a'.repeat(64) }),
      updateBookChapter: async () => ({ chapterCount: 3, index: 2, textLength: 20, title: 'saved title' }),
      deleteBookChapter: async () => ({ chapterCount: 2, deletedIndex: 2, nextIndex: 2 }),
      getReaderChapter, getReaderResource, resetReaderChapterCache: reset,
    });
    await editor.open(2);
    apiRequestMock.mockResolvedValueOnce(resourcePayload('v2'));
    const onDeleted = vi.fn();
    await editor.remove(onDeleted);
    expect(reset).toHaveBeenCalledWith('book-1');
    expect(onDeleted.mock.calls[0]?.[1]).toBe(2);
    expect(onDeleted.mock.calls[0]?.[2]).toBe(0);
    apiRequestMock.mockResolvedValueOnce({ ...chapterPayload(2), content: 'reindexed chapter' });
    expect((await getReaderChapter('book-1', 2)).content).toBe('reindexed chapter');
    apiRequestMock.mockClear();
    await getReaderChapter('book-2', 2);
    expect(apiRequestMock).not.toHaveBeenCalled();
    editor.invalidate();
  });

  it('maps matching stable position keys from the catalogue and chapter body', async () => {
    apiRequestMock.mockResolvedValueOnce({ ...resourcePayload('v1'), toc: [{ index: 2, title: 'Chapter', position_key: 'asset-b', progress_weight: 200 }] });
    const resource = await getReaderResource('book-1');
    apiRequestMock.mockResolvedValueOnce({ ...chapterPayload(2), position_key: 'asset-b' });
    const chapter = await getReaderChapter('book-1', 2);
    expect('toc' in resource && resource.toc[0].positionKey).toBe('asset-b');
    expect(chapter.positionKey).toBe('asset-b');
  });
});
