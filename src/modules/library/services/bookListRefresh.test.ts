import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Book, BookListResult } from '../../books';
import { captureCollectionAnchor, loadBookListWindow } from './bookListRefresh';

function page(index: number, ids: string[], hasMore = true, total = 6): BookListResult {
  return { books: ids.map((id) => ({ id } as Book)), hasMore, page: index, pageSize: 2, total };
}

describe('complete shelf refresh', () => {
  it('replaces all previously loaded pages in order without fetching the rest of the library', async () => {
    const load = vi.fn().mockResolvedValueOnce(page(1, ['a', 'b'])).mockResolvedValueOnce(page(2, ['c', 'd']));
    const result = await loadBookListWindow(load, 2, new AbortController().signal);
    expect(result.books.map((book) => book.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result).toMatchObject({ page: 2, hasMore: true, total: 6 });
    expect(load.mock.calls).toEqual([[1], [2]]);
  });

  it('stops when books have been removed and fewer pages now exist', async () => {
    const load = vi.fn().mockResolvedValue(page(1, ['a'], false, 1));
    expect(await loadBookListWindow(load, 3, new AbortController().signal)).toMatchObject({ page: 1, hasMore: false, total: 1 });
    expect(load).toHaveBeenCalledOnce();
  });

  it('rejects the whole refresh when a later page fails', async () => {
    const load = vi.fn().mockResolvedValueOnce(page(1, ['a', 'b'])).mockRejectedValueOnce(new Error('offline'));
    await expect(loadBookListWindow(load, 2, new AbortController().signal)).rejects.toThrow('offline');
  });

  it.each([
    page(2, ['b', 'c']),
    page(2, ['c', 'd'], true, 7),
    page(1, ['c', 'd']),
  ])('rejects a shifted, inconsistent window rather than hiding skipped books', async (next) => {
    const load = vi.fn().mockResolvedValueOnce(page(1, ['a', 'b'])).mockResolvedValueOnce(next);
    await expect(loadBookListWindow(load, 2, new AbortController().signal)).rejects.toThrow('图书列表正在变化');
  });

  it('does not continue loading when an ignored abort responds late', async () => {
    const controller = new AbortController();
    const load = vi.fn(async () => { controller.abort(); return page(1, ['a', 'b']); });
    await expect(loadBookListWindow(load, 3, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).toHaveBeenCalledOnce();
  });
});

describe('visible book anchoring', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const row = (id: string, top: number) => ({ dataset: { bookId: id }, getBoundingClientRect: () => ({ top, bottom: top + 200 }) });
    let rows = [row('a', -50), row('b', 150), row('c', 350)];
    const root = { isConnected: true, querySelectorAll: () => rows };
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollY: 1000, scrollTo });
    vi.stubGlobal('document', { querySelector: () => root, body: { style: { position: '' } } });
    return { root, scrollTo, setRows: (items: Array<[string, number]>) => { rows = items.map(([id, top]) => row(id, top)); } };
  }

  it('keeps the visible book at its offset when rows above it reorder', () => {
    const { scrollTo, setRows } = setup();
    const restore = captureCollectionAnchor('.library-page');
    setRows([['a', 150], ['b', 350], ['c', 550]]);
    restore();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1200, behavior: 'instant' });
  });

  it('uses the next visible book when the former anchor was removed', () => {
    const { scrollTo, setRows } = setup();
    const restore = captureCollectionAnchor('.library-page');
    setRows([['b', -50], ['c', 150]]);
    restore();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 800, behavior: 'instant' });
  });

  it('does not scroll a different page after its collection was unmounted', () => {
    const { root, scrollTo } = setup();
    const restore = captureCollectionAnchor('.library-page');
    root.isConnected = false;
    restore();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
