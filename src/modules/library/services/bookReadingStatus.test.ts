import { describe, expect, it } from 'vitest';
import type { Book } from '../../books';
import { getBookReadingStatus } from './bookReadingStatus';

const baseBook: Book = {
  author: '测试作者',
  createdAt: '2026-05-20T00:00:00.000Z',
  description: '测试图书',
  id: 'book-1',
  kind: 'novel',
  progressPercent: 0,
  readerType: 'epub',
  status: 'ready',
  tags: [],
  title: '测试图书',
  updatedAt: '2026-05-20T00:00:00.000Z',
};

describe('getBookReadingStatus', () => {
  it('distinguishes a failed resource read from a pending load', () => {
    const availability = { canReadInBrowser: true, entryPath: '/reader/novel/book-1' };
    expect(getBookReadingStatus(baseBook, null, availability)).toMatchObject({ resourceLabel: '读取中', tone: 'accent' });
    expect(getBookReadingStatus(baseBook, null, availability, true)).toMatchObject({ label: '资源读取失败', resourceLabel: '待重试', tone: 'warning' });
    expect(getBookReadingStatus({ ...baseBook, status: 'processing' }, null, availability, true)).toMatchObject({ label: '正在解析', tone: 'accent' });
  });
  it('summarizes extracted chapter resources', () => {
    expect(
      getBookReadingStatus(baseBook, { chapterCount: 12, readerType: 'epub', toc: [] }, { canReadInBrowser: true, entryPath: '/reader/novel/book-1' }),
    ).toMatchObject({ label: '正文已就绪', resourceLabel: '12 章', tone: 'success' });
  });

  it('summarizes pdf preview resources', () => {
    expect(
      getBookReadingStatus(
        { ...baseBook, kind: 'pdf', readerType: 'pdf' },
        { fileUrl: '/api/v1/files/books/book-1/pdf', readerType: 'pdf' },
        { canReadInBrowser: true, entryPath: '/reader/novel/book-1' },
      ),
    ).toMatchObject({ label: 'PDF 预览已就绪', resourceLabel: 'PDF 原文件', tone: 'success' });
  });

  it('prioritizes processing and failed book statuses', () => {
    expect(
      getBookReadingStatus({ ...baseBook, status: 'processing' }, null, { canReadInBrowser: true, entryPath: '/reader/novel/book-1' }),
    ).toMatchObject({ label: '正在解析', resourceLabel: '处理中', tone: 'accent' });

    expect(
      getBookReadingStatus({ ...baseBook, readerType: 'unsupported', status: 'failed' }, null, { canReadInBrowser: false, entryPath: '/books/book-1', reason: '解析失败' }),
    ).toMatchObject({ label: '解析失败', resourceLabel: '仅原文件', tone: 'danger' });
  });

  it('summarizes readable image pages', () => {
    expect(
      getBookReadingStatus(
        { ...baseBook, kind: 'manga', readerType: 'comic' },
        { pageCount: 2, pages: [{ imageUrl: '/api/v1/files/books/book-1/pages/1', index: 1 }, { index: 2 }], readerType: 'comic' },
        { canReadInBrowser: true, entryPath: '/reader/manga/book-1' },
      ),
    ).toMatchObject({ label: '漫画页已就绪', resourceLabel: '1/2 页', tone: 'success' });
  });
});
