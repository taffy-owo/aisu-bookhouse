import { describe, expect, it } from 'vitest';
import type { Book } from '../types/book';
import { getBrowserReaderAvailability } from './readerAvailability';

const baseBook: Book = {
  author: '测试作者',
  createdAt: '2026-05-20T00:00:00.000Z',
  description: '测试图书',
  id: 'book-1',
  kind: 'novel',
  progressPercent: 0,
  readerType: 'epub',
  tags: [],
  title: '测试图书',
  updatedAt: '2026-05-20T00:00:00.000Z',
};

describe('getBrowserReaderAvailability', () => {
  it('allows epub and text books only when reader chapters exist', () => {
    expect(getBrowserReaderAvailability(baseBook, { chapterCount: 1, toc: [] })).toMatchObject({
      canReadInBrowser: true,
      entryPath: '/reader/novel/book-1',
    });

    expect(getBrowserReaderAvailability(baseBook, { chapterCount: 0, toc: [] })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });
  });

  it('allows pdf books when the original file URL is available or resource is not loaded yet', () => {
    const pdfBook: Book = {
      ...baseBook,
      kind: 'pdf',
      readerType: 'pdf',
    };

    expect(getBrowserReaderAvailability(pdfBook)).toMatchObject({
      canReadInBrowser: true,
      entryPath: '/reader/novel/book-1',
    });

    expect(getBrowserReaderAvailability(pdfBook, { fileUrl: '/api/v1/files/books/book-1/pdf', readerType: 'pdf' })).toMatchObject({
      canReadInBrowser: true,
      entryPath: '/reader/novel/book-1',
    });

    expect(getBrowserReaderAvailability(pdfBook, { readerType: 'pdf' })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });
  });

  it('keeps processing and failed books on the detail page', () => {
    expect(getBrowserReaderAvailability({ ...baseBook, status: 'processing' })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });

    expect(getBrowserReaderAvailability({ ...baseBook, status: 'failed' })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });
  });

  it('uses chapter counts from the shelf before loading a full catalogue', () => {
    expect(getBrowserReaderAvailability({ ...baseBook, status: 'ready', chapterCount: 12 })).toMatchObject({
      canReadInBrowser: true,
      entryPath: '/reader/novel/book-1',
    });
    expect(getBrowserReaderAvailability({ ...baseBook, status: 'ready', chapterCount: 0 })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });
  });

  it.each(['comic', 'image'] as const)('opens a parsed %s from the shelf without fetching its page list', (readerType) => {
    const book: Book = { ...baseBook, status: 'ready', readerType, pageCount: 20 };
    expect(getBrowserReaderAvailability(book)).toMatchObject({
      canReadInBrowser: true,
      entryPath: '/reader/manga/book-1',
    });
    expect(getBrowserReaderAvailability({ ...book, pageCount: 0 })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });
    expect(getBrowserReaderAvailability({ ...book, status: 'processing' })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });
    expect(getBrowserReaderAvailability(book, { pageCount: 0, pages: [] })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });
  });

  it('allows comic and image books only when real image URLs exist', () => {
    const comicBook: Book = {
      ...baseBook,
      kind: 'manga',
      readerType: 'comic',
    };

    expect(getBrowserReaderAvailability(comicBook, { pageCount: 2, pages: [{ index: 1 }, { index: 2 }] })).toMatchObject({
      canReadInBrowser: false,
      entryPath: '/books/book-1',
    });

    expect(getBrowserReaderAvailability(comicBook, { pageCount: 2, pages: [{ imageUrl: '/api/v1/files/books/book-1/pages/1', index: 1 }] })).toMatchObject({
      canReadInBrowser: true,
      entryPath: '/reader/manga/book-1',
    });
  });
});
