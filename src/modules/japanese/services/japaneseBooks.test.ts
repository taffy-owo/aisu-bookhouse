import { describe, expect, it } from 'vitest';
import type { Book } from '../../books';
import { filterJapaneseBooks, isJapaneseBook } from './japaneseBooks';

const baseBook: Book = {
  author: '作者',
  createdAt: '2026-01-01T00:00:00Z',
  description: '',
  id: 'book',
  kind: 'novel',
  progressPercent: 0,
  readerType: 'epub',
  tags: [],
  title: '作品',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('japaneseBooks', () => {
  it('keeps a saved zero-percent position in reading until reset to unread', () => {
    const book = { ...baseBook, language: 'ja' as const, lastReadAt: '2026-11-05T01:00:00Z' };
    expect(filterJapaneseBooks([book], 'reading')).toEqual([book]);
    expect(filterJapaneseBooks([book], 'unread')).toEqual([]);
    expect(filterJapaneseBooks([{ ...book, lastReadAt: undefined }], 'unread')).toHaveLength(1);
  });
  it('uses structured language metadata first', () => {
    expect(isJapaneseBook({ ...baseBook, language: 'ja' })).toBe(true);
    expect(isJapaneseBook({ ...baseBook, language: 'zh', title: 'わたしの本' })).toBe(false);
  });

  it('does not treat a Japanese title or author as proof of original language', () => {
    expect(isJapaneseBook({ ...baseBook, author: 'ゆのゆみ', language: 'und', title: '向信奉的少女献身' })).toBe(false);
    expect(isJapaneseBook({ ...baseBook, language: 'und', title: 'わたしの百合は仕事です！' })).toBe(false);
  });

  it('filters reading state and query together', () => {
    const books = [
      { ...baseBook, id: 'a', language: 'ja' as const, progressPercent: 32, title: '少女の夏' },
      { ...baseBook, id: 'b', language: 'ja' as const, progressPercent: 100, title: '冬の花' },
    ];
    expect(filterJapaneseBooks(books, 'reading', '少女').map((book) => book.id)).toEqual(['a']);
    expect(filterJapaneseBooks(books, 'finished').map((book) => book.id)).toEqual(['b']);
  });
});
