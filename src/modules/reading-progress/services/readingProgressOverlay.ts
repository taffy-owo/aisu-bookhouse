import { readProgressStore } from './readingProgressStore';
import type { ReaderType } from '../../books';

type ProgressOverlayTarget = {
  currentChapter?: string;
  id: string;
  progressPercent: number;
  readerType: ReaderType;
  updatedAt: string;
  lastReadAt?: string;
};

export function overlayProgressToBook<TBook extends ProgressOverlayTarget>(book: TBook): TBook {
  const store = readProgressStore();
  const progress = store[book.id];

  if (!progress) {
    return book;
  }

  const hasHistory = progress.progressPercent > 0 || progress.chapterIndex !== undefined
    || progress.pageNumber !== undefined || progress.imageIndex !== undefined
    || Boolean(progress.chapterHref || progress.epubCfi);
  let currentChapter = hasHistory ? book.currentChapter : undefined;

  if (book.readerType === 'comic' || book.readerType === 'image') {
    if (progress.imageIndex !== undefined) {
      currentChapter = `第 ${progress.imageIndex} 页`;
    }
  } else if (book.readerType !== 'unsupported') {
    if (progress.chapterIndex !== undefined) {
      currentChapter = `第 ${progress.chapterIndex} 章`;
    }
  }

  return {
    ...book,
    currentChapter,
    progressPercent: progress.progressPercent,
    updatedAt: progress.updatedAt,
    lastReadAt: hasHistory ? progress.updatedAt : undefined,
  };
}

export function overlayProgress<TBook extends ProgressOverlayTarget>(books: TBook[]): TBook[] {
  return books.map(overlayProgressToBook);
}
