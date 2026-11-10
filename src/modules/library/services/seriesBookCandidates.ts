import { getBookList, getPublicBookList } from '../../books/services/bookService';
import type { Book } from '../../books/types/book';
import { getBookSeriesInfo } from './bookSeries';

export async function getSeriesBookCandidates(book: Book, signal?: AbortSignal): Promise<Book[]> {
  const series = getBookSeriesInfo(book);
  if (series.source === 'single') return [book];

  const getPage = book.isOwned === false ? getPublicBookList : getBookList;
  const books: Book[] = [];
  for (let page = 1; ; page += 1) {
    const result = await getPage({ q: series.label, page, pageSize: 100, signal });
    books.push(...result.books);
    if (!result.hasMore) return books;
  }
}
