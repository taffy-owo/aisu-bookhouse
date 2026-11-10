import type { ReaderChapter, ReaderResource } from './reader';

export type ChapterLoadState = {
  bookId: string;
  chapter: ReaderChapter | null;
  chapterIndex: number;
  error: string | null;
  isLoading: boolean;
};

export type ReaderResourceLoadState = {
  bookId: string;
  isLoaded: boolean;
  resource: ReaderResource | null;
  pendingResource?: ReaderResource;
};
