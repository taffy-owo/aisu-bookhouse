import { describe, expect, it } from 'vitest';
import type { Book } from '../types/book';
import { getBookExtentLabel, getBookLengthLabel } from './bookLength';

const baseBook: Book = {
  author: '作者',
  createdAt: '2026-01-01T00:00:00Z',
  description: '',
  id: 'book-1',
  kind: 'novel',
  progressPercent: 0,
  readerType: 'epub',
  tags: [],
  title: '测试书',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('book length metadata', () => {
  it('classifies novels by character count and shows exact shelf metadata', () => {
    const book = { ...baseBook, chapterCount: 79, characterCount: 101_240 };

    expect(getBookLengthLabel(book)).toBe('中篇');
    expect(getBookExtentLabel(book)).toBe('10.1万字 · 79章');
  });

  it('falls back to chapter count when a novel has no character count', () => {
    const book = { ...baseBook, chapterCount: 82 };

    expect(getBookLengthLabel(book)).toBe('长篇');
    expect(getBookExtentLabel(book)).toBe('82章');
  });

  it('uses page-based metadata for comics', () => {
    const book: Book = { ...baseBook, kind: 'manga', pageCount: 136, readerType: 'comic' };

    expect(getBookLengthLabel(book)).toBe('136页');
    expect(getBookExtentLabel(book)).toBe('136页');
  });
});
