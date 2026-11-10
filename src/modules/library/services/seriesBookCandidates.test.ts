import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBookList, getPublicBookList } from '../../books/services/bookService';
import type { Book } from '../../books/types/book';
import { getBookSeriesShelf } from './bookSeries';
import { getSeriesBookCandidates } from './seriesBookCandidates';

vi.mock('../../books/services/bookService', () => ({ getBookList: vi.fn(), getPublicBookList: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const base: Book = {
  id: 'v1', title: '旅途 第一卷', author: '作者', kind: 'novel', readerType: 'epub',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', description: '', tags: [], progressPercent: 0,
};

describe('series book candidates', () => {
  it('keeps the next volume beyond the first 100 search results', async () => {
    const books = Array.from({ length: 101 }, (_, i) => ({ ...base, id: `v${i + 1}`, title: `旅途 第${i + 1}卷` }));
    vi.mocked(getBookList)
      .mockResolvedValueOnce({ books: books.slice(0, 100), hasMore: true, page: 1, pageSize: 100, total: 101 })
      .mockResolvedValueOnce({ books: books.slice(100), hasMore: false, page: 2, pageSize: 100, total: 101 });
    const result = await getSeriesBookCandidates(books[99]!);
    expect(getBookSeriesShelf(books[99]!, result)?.nextBook?.id).toBe('v101');
    expect(getBookList).toHaveBeenLastCalledWith({ q: '旅途', page: 2, pageSize: 100, signal: undefined });
    expect(getPublicBookList).not.toHaveBeenCalled();
  });

  it('finds another reader’s public volumes through the public library', async () => {
    const current = { ...base, isOwned: false };
    const next = { ...current, id: 'v2', title: '旅途 第二卷' };
    vi.mocked(getPublicBookList).mockResolvedValue({ books: [current, next], hasMore: false, page: 1, pageSize: 100, total: 2 });
    const result = await getSeriesBookCandidates(current);
    expect(getBookSeriesShelf(current, result)?.nextBook?.id).toBe('v2');
    expect(getBookList).not.toHaveBeenCalled();
  });

  it('does not search for volumes of a standalone book', async () => {
    const single = { ...base, title: '一篇短篇' };
    expect(await getSeriesBookCandidates(single)).toEqual([single]);
    expect(getBookList).not.toHaveBeenCalled();
    expect(getPublicBookList).not.toHaveBeenCalled();
  });
});
