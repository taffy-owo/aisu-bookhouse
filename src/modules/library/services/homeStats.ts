import { hasBookReadingHistory } from '../../books/services/bookProgress';
import type { Book } from '../../books';

export interface HomeReadingStats {
  finishedBooks: number;
  inProgressBooks: number;
  totalBooks: number;
}

export function buildHomeReadingStats(books: Book[]): HomeReadingStats {
  return {
    finishedBooks: books.filter((book) => book.progressPercent >= 100).length,
    inProgressBooks: books.filter((book) => hasBookReadingHistory(book) && book.progressPercent < 100).length,
    totalBooks: books.length,
  };
}
