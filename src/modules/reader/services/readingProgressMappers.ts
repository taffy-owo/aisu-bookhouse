import { getAccountScope } from '../../../shared/api/authTokenStore';
import type { ReaderType } from '../../books/types/book';
import type { ReadingProgress } from '../types/reader';
import { normalizeProgressTimestamp, observeReadingProgressTimestamp } from './progressTimestamp';

export type BackendReadingProgress = {
  book_id: string;
  chapter_href: string | null;
  chapter_index: number | null;
  epub_cfi: string | null;
  image_index: number | null;
  page_number: number | null;
  progress_percent: number;
  reader_type: ReaderType;
  updated_at: string;
};

export function mapBackendReadingProgress(progress: BackendReadingProgress, scope = getAccountScope()): ReadingProgress {
  observeReadingProgressTimestamp(progress.book_id, progress.updated_at, scope);
  return {
    bookId: progress.book_id,
    chapterHref: progress.chapter_href ?? undefined,
    chapterIndex: progress.chapter_index ?? undefined,
    epubCfi: progress.epub_cfi ?? undefined,
    imageIndex: progress.image_index ?? undefined,
    pageNumber: progress.page_number ?? undefined,
    progressPercent: progress.progress_percent,
    readerType: progress.reader_type,
    updatedAt: normalizeProgressTimestamp(progress.updated_at),
  };
}
