import type { ReaderType } from '../../books';

export type ReadingProgress = {
  bookId: string;
  contentVersion?: string;
  positionKey?: string;
  chapterIndex?: number;
  chapterHref?: string;
  epubCfi?: string;
  imageIndex?: number;
  pageNumber?: number;
  progressPercent: number;
  readerType?: ReaderType;
  updatedAt: string;
};
