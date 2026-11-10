import type { Book } from '../../books';
import type { BookReadingCompletionResult, BookUpdateInput } from '../../books/services/bookService';
import type { ReadingProgress } from '../../reader/types/reader';
import { compareAppTimestamps } from '../../../shared/utils/formatDate';

export type BookActionKind = 'favorite' | 'disliked' | 'reading' | 'cover' | 'source' | 'public' | 'processing' | BookUpdateInput;

const sourceFields = ['sourceUrl', 'sourceEpisodeCount', 'sourceCharacterCount', 'sourceUpdateCount', 'sourceCheckedAt', 'sourceCheckError', 'sourceScheduleTime', 'sourceScheduleTimezone', 'sourceScheduleLabel'] as const;
const actionFields: Record<Exclude<BookActionKind, BookUpdateInput>, readonly (keyof Book)[]> = {
  favorite: ['favorite'],
  disliked: ['disliked'],
  reading: ['progressPercent', 'currentChapter', 'lastReadAt'],
  cover: ['coverUrl'],
  source: [...sourceFields, 'publicationStatus'],
  public: ['publicStatus', 'publicRequestedAt', 'publicApprovedAt', 'publicRejectedAt', 'publicShareNote', 'publicSourceNote', 'publicDownloadAllowed', 'readersLabel'],
  processing: ['status'],
};

/** Responses contain full snapshots, but parallel actions own different fields. */
export function mergeBookActionResult(current: Book, response: Book, action: BookActionKind): Book {
  if (current.id !== response.id) return current;
  const fields = typeof action === 'string'
    ? actionFields[action]
    : Object.keys(action).filter((key) => action[key as keyof BookUpdateInput] !== undefined) as (keyof Book)[];
  const keys = new Set<keyof Book>(fields);
  if (typeof action !== 'string') {
    if (action.language !== undefined) keys.add('languageMode');
    if (action.sourceUrl !== undefined) sourceFields.forEach((field) => keys.add(field));
    if (action.sourceEpisodeCount !== undefined) {
      keys.add('sourceUpdateCount');
      keys.add('sourceCheckedAt');
      keys.add('sourceCheckError');
    }
  }
  const patch = Object.fromEntries([...keys].map((key) => [key, response[key]]));
  const updatedAt = compareAppTimestamps(response.updatedAt, current.updatedAt) > 0 ? response.updatedAt : current.updatedAt;
  const version = compareAppTimestamps(response.version ?? '', current.version ?? '') > 0 || !current.version ? response.version : current.version;
  return { ...current, ...patch, updatedAt, ...(version ? { version } : {}) };
}

export function applyBookReadingCompletion(current: ReadingProgress | null, book: BookReadingCompletionResult, finished: boolean): ReadingProgress {
  if (book.readingProgress?.bookId === book.id && book.readingProgress.readerType === book.readerType) {
    return { ...book.readingProgress };
  }
  return {
    ...(finished && current?.bookId === book.id && (!current.readerType || current.readerType === book.readerType) ? current : {}),
    bookId: book.id,
    progressPercent: finished ? 100 : 0,
    readerType: book.readerType,
    updatedAt: book.updatedAt,
  };
}
