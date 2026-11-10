import { getBookDetailPath } from '../../../config/routes';
import type { Book } from '../types/book';
import { getReaderRouteForBook } from './bookService';

type BrowserReaderResource =
  | {
      chapterCount: number;
      toc: unknown[];
    }
  | {
      pageCount: number;
      pages: Array<{ index: number; imageUrl?: string }>;
    }
  | {
      fileUrl?: string;
      readerType?: 'pdf';
    };

export type BrowserReaderAvailability = {
  canReadInBrowser: boolean;
  entryPath: string;
  reason?: string;
};

export function getBrowserReaderAvailability(book: Book, resource?: BrowserReaderResource | null): BrowserReaderAvailability {
  if (book.status === 'uploading' || book.status === 'processing') {
    return {
      canReadInBrowser: false,
      entryPath: getBookDetailPath(book.id),
      reason: '文件正在解析在线阅读资源，完成后会自动开放阅读入口。',
    };
  }

  if (book.status === 'failed') {
    return {
      canReadInBrowser: false,
      entryPath: getBookDetailPath(book.id),
      reason: '文件已保存，但解析没有完成，可先下载原文件阅读。',
    };
  }

  if (book.readerType === 'unsupported') {
    return {
      canReadInBrowser: false,
      entryPath: getBookDetailPath(book.id),
      reason: '当前文件已保存，但这个格式暂时不能在线解析。',
    };
  }

  if (book.readerType === 'pdf') {
    const hasFileUrl = Boolean(resource && 'fileUrl' in resource && resource.fileUrl);
    return {
      canReadInBrowser: !resource || hasFileUrl,
      entryPath: !resource || hasFileUrl ? getReaderRouteForBook(book) : getBookDetailPath(book.id),
      reason: !resource || hasFileUrl ? undefined : 'PDF 原文件还没有准备好，可先稍后再试。',
    };
  }

  if (book.readerType === 'comic' || book.readerType === 'image') {
    const hasReadableImagePage = resource
      ? 'pages' in resource && resource.pages.some((page) => Boolean(page.imageUrl))
      : (book.pageCount ?? 0) > 0;
    return {
      canReadInBrowser: hasReadableImagePage,
      entryPath: hasReadableImagePage ? getReaderRouteForBook(book) : getBookDetailPath(book.id),
      reason: hasReadableImagePage ? undefined : '图片页还没有完成解析，可先下载原文件阅读。',
    };
  }

  if (resource && 'chapterCount' in resource) {
    const hasChapters = resource.chapterCount > 0;
    return {
      canReadInBrowser: hasChapters,
      entryPath: hasChapters ? getReaderRouteForBook(book) : getBookDetailPath(book.id),
      reason: hasChapters ? undefined : '这本书还没有可阅读的正文目录。',
    };
  }

  if (resource) {
    return {
      canReadInBrowser: false,
      entryPath: getBookDetailPath(book.id),
      reason: '这本书没有可阅读的正文资源，可先下载原文件阅读。',
    };
  }

  if (book.chapterCount === 0) {
    return {
      canReadInBrowser: false,
      entryPath: getBookDetailPath(book.id),
      reason: '这本书还没有可阅读的正文目录。',
    };
  }

  return {
    canReadInBrowser: true,
    entryPath: getReaderRouteForBook(book),
  };
}
