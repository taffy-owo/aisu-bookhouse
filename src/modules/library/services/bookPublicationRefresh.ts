import type { Book } from '../../books';
import { getBookById, getEditableBookChapters, invalidateBookListCache } from '../../books/services/bookService';
import { getReaderResource, getReadingProgress } from '../../reader/services/readerService';
import type { ReaderResource, ReadingProgress } from '../../reader/types/reader';
import type { WholeBookTranslationJob } from '../../uploads/services/wholeBookTranslationService';
import { compareAppTimestamps } from '../../../shared/utils/formatDate';

export interface BookPublicationState {
  bookId: string;
  sessionId?: string;
  book: Book | null;
  readerResource: ReaderResource | null;
  ready: boolean;
  busy: boolean;
  mutationRevision: number;
  job: WholeBookTranslationJob | null;
}

export interface BookPublicationSnapshot {
  book: Book;
  readerResource: ReaderResource;
  readingProgress: ReadingProgress;
  editableChapterIndexes: Set<number>;
}

export function getBookPublicationKey(job: WholeBookTranslationJob | null): string | null {
  return job ? JSON.stringify([job.id, job.completed_chapters, job.status, job.stage]) : null;
}

/** Checkpoints can advance before their readable prefix is actually published. */
function canPublish(job: WholeBookTranslationJob | null): boolean {
  return Boolean(job && (job.status === 'processing' || job.status === 'queued')
    && (job.job_kind === 'whole_book' || job.stage === 'packaging'));
}

function sameVersion(first?: string, second?: string): boolean {
  return first === second || compareAppTimestamps(first ?? '', second ?? '') === 0;
}

export function canEditBookChapters(book: Book): boolean {
  return book.isOwned !== false && book.status === 'ready' && (book.readerType === 'epub' || book.readerType === 'text');
}

/** Adopt a catalogue, its editing controls and progress as one readable edition. */
export async function getBookPublicationSnapshot(book: Book, signal: AbortSignal): Promise<BookPublicationSnapshot> {
  const [readerResource, chapters, readingProgress] = await Promise.all([
    getReaderResource(book.id, signal),
    canEditBookChapters(book) ? getEditableBookChapters(book.id, signal) : Promise.resolve([]),
    getReadingProgress(book.id, signal),
  ]);
  const version = book.version ?? book.updatedAt;
  if (readerResource.version && !sameVersion(version, readerResource.version)) {
    throw new Error('图书内容正在更新');
  }
  if ('chapterCount' in readerResource && book.chapterCount !== undefined
    && readerResource.chapterCount !== book.chapterCount) {
    throw new Error('新章节目录正在同步');
  }
  return { book, readerResource, readingProgress, editableChapterIndexes: new Set(chapters.map((chapter) => chapter.index)) };
}

/** Keep the visible edition intact until all of the next edition is available. */
export function createBookPublicationRefresher(
  { bookId, sessionId }: Pick<BookPublicationState, 'bookId' | 'sessionId'>,
  getState: () => BookPublicationState,
  onRefresh: (snapshot: BookPublicationSnapshot) => void,
  onError: (failed: boolean) => void,
) {
  let confirmedJobKey: string | null = null;
  let invalidation = 0;
  let confirmedInvalidation = 0;
  let retry = false;
  let latestRequest = 0;

  return {
    invalidate() { invalidation += 1; },
    async refresh(signal: AbortSignal) {
      const initial = getState();
      if (!initial.ready || !initial.book || initial.busy
        || initial.bookId !== bookId || initial.book.id !== bookId || initial.sessionId !== sessionId) return;
      const jobKey = getBookPublicationKey(initial.job);
      const mutationRevision = initial.mutationRevision;
      const revision = invalidation;
      const force = retry || jobKey !== confirmedJobKey || revision !== confirmedInvalidation;
      const isProcessing = initial.book.status === 'uploading' || initial.book.status === 'processing';
      if (!force && !canPublish(initial.job) && !isProcessing) return;
      const request = ++latestRequest;
      const isCurrent = () => {
        const current = getState();
        return !signal.aborted && request === latestRequest
          && current.bookId === bookId && current.sessionId === sessionId
          && current.ready && !current.busy
          && current.mutationRevision === mutationRevision;
      };
      retry = true;
      try {
        const book = await getBookById(bookId, signal);
        if (!isCurrent()) return;
        if (!book) throw new Error('图书信息暂时无法读取');
        const current = getState();
        const version = book.version ?? book.updatedAt;
        const currentVersion = current.book?.version ?? current.book?.updatedAt;
        // A response captured before a newer edit must not roll it back.
        if (compareAppTimestamps(version, currentVersion ?? '') < 0) return;
        if (force || book.status !== current.book?.status || !sameVersion(version, currentVersion)
          || (current.readerResource?.version && !sameVersion(version, current.readerResource.version))) {
          const snapshot = await getBookPublicationSnapshot(book, signal);
          if (!isCurrent()) return;
          invalidateBookListCache();
          onRefresh(snapshot);
        }
        confirmedJobKey = jobKey;
        confirmedInvalidation = revision;
        retry = false;
        onError(false);
      } catch {
        if (isCurrent()) onError(true);
      }
    },
  };
}
