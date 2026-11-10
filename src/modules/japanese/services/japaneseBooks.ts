import { hasBookReadingHistory } from '../../books/services/bookProgress';
import type { Book } from '../../books';

export type JapaneseShelfFilter = 'all' | 'reading' | 'unread' | 'finished';

export function isJapaneseBook(book: Book): boolean {
  return book.language === 'ja';
}

export function filterJapaneseBooks(books: Book[], filter: JapaneseShelfFilter, query = ''): Book[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return books.filter((book) => {
    if (!isJapaneseBook(book)) {
      return false;
    }
    if (filter === 'reading' && !(hasBookReadingHistory(book) && book.progressPercent < 100)) {
      return false;
    }
    if (filter === 'unread' && hasBookReadingHistory(book)) {
      return false;
    }
    if (filter === 'finished' && book.progressPercent < 100) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return `${book.title} ${book.author} ${book.tags.join(' ')}`.toLocaleLowerCase().includes(normalizedQuery);
  });
}
