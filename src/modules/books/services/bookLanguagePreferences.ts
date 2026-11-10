import type { Book, BookLanguage } from '../types/book';

export type BookLanguageSetting = BookLanguage | 'auto';

export function getBookLanguageSetting(book: Pick<Book, 'language' | 'languageMode'>): BookLanguageSetting {
  if (book.languageMode === 'auto' || (!book.languageMode && (!book.language || book.language === 'und'))) return 'auto';
  return book.language ?? 'und';
}

export const bookLanguageLabels: Record<BookLanguage, string> = {
  und: '尚未识别', zh: '中文', ja: '日文', en: '英文', other: '其他语言',
};
