import { hasBookReadingHistory } from './bookProgress';
import { getBookDetailPath, getMangaReaderPath, getNovelReaderPath } from '../../../config/routes';
import { ApiError, apiRequest, assertAccountScope, buildApiResourceUrl, getAccountScope, isBackendApiEnabled } from '../../../shared/api';
import { overlayProgress, overlayProgressToBook } from '../../reading-progress';
import { LOCAL_IMPORTED_BOOKS } from '../data/localImportedBooks';
import { FALLBACK_BOOKS } from '../data/fallbackBooks';
import type { Book, BookKind, BookLanguage, BookPublicationStatus, BookSortKey } from '../types/book';
import type { BackendBook, BackendBookListResponse, BackendBookShelfOverview, BackendSourceUpdateNotificationList } from './bookApiTypes';
import { mapBackendBook } from './bookMappers';
import type { BookLanguageSetting } from './bookLanguagePreferences';
import { flushReadingProgressSync, getPendingReadingProgress } from '../../reader/services/readingProgressSync';
import { createReadingProgressTimestamp, observeReadingProgressTimestamp } from '../../reader/services/progressTimestamp';
import { mapBackendReadingProgress, type BackendReadingProgress } from '../../reader/services/readingProgressMappers';
import type { ReadingProgress } from '../../reader/types/reader';
import { chapterMutationRequest } from './chapterMutationRequest';

export interface SearchBooksParams {
  kind?: BookKind | 'all';
  language?: BookLanguage;
  page?: number;
  pageSize?: number;
  q?: string;
  signal?: AbortSignal;
  sort?: BookSortKey;
  shelf?: 'all' | 'favorite' | 'recent' | 'finished' | 'unread' | 'disliked';
  tag?: string;
}

export interface BookListResult {
  books: Book[];
  hasMore: boolean;
  page: number;
  pageSize: number;
  total: number;
}

export interface BookShelfOverview {
  ongoingCount: number;
  sourceUpdateCount: number;
  updatedBooks: Book[];
  bookLabels: Array<Pick<Book, 'id' | 'title'>>;
  books: Book[];
  continueBook: Book | null;
  favoriteCount: number;
  finishedCount: number;
  inProgressCount: number;
  total: number;
}

export interface SourceUpdateNotifications {
  bookCount: number;
  episodeCount: number;
  items: Book[];
}

export interface SourceCatalogSyncResult {
  catalogCount: number;
  matchedCount: number;
  renamedCount: number;
}

export const SOURCE_UPDATE_NOTIFICATIONS_CHANGED_EVENT = 'aisu:source-update-notifications-changed';

export interface BookUpdateInput {
  autoTranslateUpdates?: boolean;
  author?: string;
  description?: string;
  language?: BookLanguageSetting;
  publicationStatus?: BookPublicationStatus;
  rating?: number;
  seriesKind?: string | null;
  seriesOrder?: number | null;
  seriesTitle?: string | null;
  sourceUrl?: string | null;
  sourceEpisodeCount?: number | null;
  sourceCharacterCount?: number | null;
  sourceScheduleTime?: string | null;
  sourceScheduleTimezone?: 'Asia/Tokyo' | null;
  sourceScheduleLabel?: string | null;
  tags?: string[];
  title?: string;
}

export interface BookPublicShareInput {
  publicDownloadAllowed: boolean;
  shareNote?: string;
  sourceNote?: string;
}

type BackendBookUpdateInput = {
  auto_translate_updates?: boolean;
  author?: string;
  description?: string;
  language?: BookLanguageSetting;
  publication_status?: BookPublicationStatus;
  rating?: number;
  series_kind?: string | null;
  series_order?: number | null;
  series_title?: string | null;
  source_url?: string | null;
  source_episode_count?: number | null;
  source_character_count?: number | null;
  source_schedule_time?: string | null;
  source_schedule_timezone?: 'Asia/Tokyo' | null;
  source_schedule_label?: string | null;
  tags?: string[];
  title?: string;
};

type BackendBookPublicShareInput = {
  public_download_allowed: boolean;
  share_note?: string | null;
  source_note?: string | null;
};

export const kindLabel: Record<BookKind, string> = {
  image: '图集',
  manga: '漫画',
  novel: '小说',
  pdf: 'PDF',
};

const ALL_BOOKS: Book[] = [...LOCAL_IMPORTED_BOOKS, ...FALLBACK_BOOKS];

const BOOK_LIST_PAGE_SIZE = 100;
const MAX_BOOK_LIST_PAGES = 200;

// The backend caps page_size at 100, so walk every page to return the full library
// instead of silently dropping books past the first page.
async function fetchAllBackendBooks(path: string, baseParams: URLSearchParams, signal?: AbortSignal): Promise<Book[]> {
  const scope = getAccountScope();
  const items: Book[] = [];
  for (let page = 1; page <= MAX_BOOK_LIST_PAGES; page += 1) {
    assertAccountScope(scope);
    const params = new URLSearchParams(baseParams);
    params.set('page', String(page));
    params.set('page_size', String(BOOK_LIST_PAGE_SIZE));
    const response = await apiRequest<BackendBookListResponse>(`${path}?${params.toString()}`, { signal });
    items.push(...response.items.map(mapBackendBook));
    const hasMore = response.has_more ?? page * BOOK_LIST_PAGE_SIZE < response.total;
    if (!hasMore || response.items.length === 0) {
      break;
    }
  }
  return items;
}

// Short module-level cache for the full private library list. Several pages
// (Home + recommendations, book detail, profile) request the same full list
// within one screen or a few seconds; this collapses them into one network
// walk. Every mutation below calls invalidateBookListCache() so the next read
// is fresh.
const BOOK_LIST_CACHE_TTL_MS = 30_000;

let bookListCache: { books: Book[]; expiresAt: number } | null = null;
let bookListCachePromise: Promise<Book[]> | null = null;
type OverviewMode = 'full' | 'compact';
let bookshelfOverviewCache: Partial<Record<OverviewMode, { overview: BookShelfOverview; expiresAt: number }>> = {};
let bookshelfOverviewPromise: Partial<Record<OverviewMode, Promise<BookShelfOverview>>> = {};
let bookCacheScope: string | null = null;

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function ensureBookCacheScope(): void {
  const scope = getAccountScope();
  if (bookCacheScope !== scope) {
    invalidateBookListCache();
    bookCacheScope = scope;
  }
}

export function invalidateBookListCache(): void {
  bookListCache = null;
  bookListCachePromise = null;
  bookshelfOverviewCache = {};
  bookshelfOverviewPromise = {};
}

export async function getBooks(signal?: AbortSignal): Promise<Book[]> {
  ensureBookCacheScope();
  if (isBackendApiEnabled()) {
    if (bookListCache && bookListCache.expiresAt > Date.now()) {
      return awaitWithAbort(Promise.resolve(bookListCache.books), signal);
    }

    if (!bookListCachePromise) {
      const request = fetchAllBackendBooks('/books', new URLSearchParams({ sort: 'recent' }))
        .then((books) => {
          if (bookListCachePromise === request) {
            bookListCache = { books, expiresAt: Date.now() + BOOK_LIST_CACHE_TTL_MS };
          }
          return books;
        })
        .finally(() => {
          if (bookListCachePromise === request) {
            bookListCachePromise = null;
          }
        });
      bookListCachePromise = request;
    }
    return awaitWithAbort(bookListCachePromise, signal);
  }

  const booksWithProgress = overlayProgress(ALL_BOOKS);
  return awaitWithAbort(Promise.resolve(sortBooks(booksWithProgress, 'recent')), signal);
}

export async function getBookshelfOverview(includeLabels = true, signal?: AbortSignal): Promise<BookShelfOverview> {
  ensureBookCacheScope();
  if (!isBackendApiEnabled()) {
    const books = await getBooks(signal);
    return buildLocalBookshelfOverview(books);
  }
  const mode: OverviewMode = includeLabels ? 'full' : 'compact';
  const cached = bookshelfOverviewCache[mode];
  if (cached && cached.expiresAt > Date.now()) {
    return awaitWithAbort(Promise.resolve(cached.overview), signal);
  }
  if (!bookshelfOverviewPromise[mode]) {
    const request = apiRequest<BackendBookShelfOverview>(`/books/overview?recent_limit=24&include_labels=${includeLabels}`)
      .then((response) => ({
        ongoingCount: response.ongoing_count ?? response.items.filter((book) => book.publication_status === 'ongoing').length,
        sourceUpdateCount: response.source_update_count ?? response.items.reduce((total, book) => total + (book.source_update_count ?? 0), 0),
        updatedBooks: (response.updated_items ?? response.items.filter((book) => (book.source_update_count ?? 0) > 0)).map(mapBackendBook),
        bookLabels: response.book_labels,
        books: response.items.map(mapBackendBook),
        continueBook: response.continue_book ? mapBackendBook(response.continue_book) : null,
        favoriteCount: response.favorite_count,
        finishedCount: response.finished_count,
        inProgressCount: response.in_progress_count,
        total: response.total,
      }))
      .then((overview) => {
        if (bookshelfOverviewPromise[mode] === request) {
          bookshelfOverviewCache[mode] = { overview, expiresAt: Date.now() + BOOK_LIST_CACHE_TTL_MS };
        }
        return overview;
      })
      .finally(() => {
        if (bookshelfOverviewPromise[mode] === request) {
          delete bookshelfOverviewPromise[mode];
        }
      });
    bookshelfOverviewPromise[mode] = request;
  }
  return awaitWithAbort(bookshelfOverviewPromise[mode]!, signal);
}

export async function getBookList(params: SearchBooksParams = {}): Promise<BookListResult> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 24;
  if (!isBackendApiEnabled()) {
    const books = searchLocalBooks(params).filter((book) => matchesShelf(book, params.shelf));
    const start = (page - 1) * pageSize;
    return { books: books.slice(start, start + pageSize), hasMore: start + pageSize < books.length, page, pageSize, total: books.length };
  }

  const searchParams = new URLSearchParams({ page: String(page), page_size: String(pageSize), sort: params.sort ?? 'recent' });
  if (params.q?.trim()) searchParams.set('q', params.q.trim());
  if (params.kind && params.kind !== 'all') searchParams.set('kind', params.kind);
  if (params.tag && params.tag !== '全部') searchParams.set('tag', params.tag);
  if (params.language) searchParams.set('language', params.language);
  if (params.shelf) searchParams.set('shelf', params.shelf);
  const response = await apiRequest<BackendBookListResponse>(`/books?${searchParams.toString()}`, { signal: params.signal });
  return mapBackendBookListResponse(response, page, pageSize);
}

function matchesShelf(book: Book, shelf: SearchBooksParams['shelf']): boolean {
  if (!shelf) return true;
  if (shelf === 'disliked') return book.disliked === true;
  if (book.disliked) return false;
  if (shelf === 'favorite') return book.favorite === true;
  if (shelf === 'recent') return hasBookReadingHistory(book) && book.progressPercent < 100;
  if (shelf === 'finished') return book.progressPercent >= 100;
  if (shelf === 'unread') return !hasBookReadingHistory(book);
  return true;
}

function buildLocalBookshelfOverview(books: Book[]): BookShelfOverview {
  const shelfBooks = books.filter((book) => !book.disliked);
  const sortedBooks = sortBooks(shelfBooks, 'recent');
  const recentBooks = [...shelfBooks].sort((left, right) => (
    Number(hasBookReadingHistory(right)) - Number(hasBookReadingHistory(left))
    || parseSafeDate(right.updatedAt, right.createdAt) - parseSafeDate(left.updatedAt, left.createdAt)
  )).slice(0, 24);
  return {
    ongoingCount: shelfBooks.filter((book) => book.publicationStatus === 'ongoing').length,
    sourceUpdateCount: shelfBooks.reduce((total, book) => total + Math.max(0, book.sourceUpdateCount ?? 0), 0),
    updatedBooks: sortedBooks.filter((book) => (book.sourceUpdateCount ?? 0) > 0).slice(0, 12),
    bookLabels: shelfBooks.map(({ id, title }) => ({ id, title })),
    books: recentBooks,
    continueBook: sortedBooks.find((book) => hasBookReadingHistory(book) && book.progressPercent < 100) ?? null,
    favoriteCount: shelfBooks.filter((book) => book.favorite).length,
    finishedCount: shelfBooks.filter((book) => book.progressPercent >= 100).length,
    inProgressCount: shelfBooks.filter((book) => hasBookReadingHistory(book) && book.progressPercent < 100).length,
    total: shelfBooks.length,
  };
}

export async function getSourceUpdateNotifications(signal?: AbortSignal): Promise<SourceUpdateNotifications> {
  if (isBackendApiEnabled()) {
    const response = await apiRequest<BackendSourceUpdateNotificationList>('/books/source-updates', { signal });
    return {
      bookCount: response.book_count,
      episodeCount: response.episode_count,
      items: response.items.map(mapBackendBook),
    };
  }

  const items = ALL_BOOKS.filter((book) => (book.sourceUpdateCount ?? 0) > 0);
  return {
    bookCount: items.length,
    episodeCount: items.reduce((total, book) => total + (book.sourceUpdateCount ?? 0), 0),
    items,
  };
}

export async function getPublicBooks(params: SearchBooksParams = {}): Promise<Book[]> {
  const result = await getPublicBookList(params);
  return result.books;
}

export async function getPublicBookList(params: SearchBooksParams = {}): Promise<BookListResult> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 24;

  if (isBackendApiEnabled()) {
    const searchParams = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      sort: params.sort ?? 'recent',
    });
    if (params.q?.trim()) {
      searchParams.set('q', params.q.trim());
    }
    if (params.kind && params.kind !== 'all') {
      searchParams.set('kind', params.kind);
    }
    if (params.tag && params.tag !== '全部') {
      searchParams.set('tag', params.tag);
    }
    if (params.language) {
      searchParams.set('language', params.language);
    }

    const response = await apiRequest<BackendBookListResponse>(`/books/public?${searchParams.toString()}`, { signal: params.signal });
    return mapBackendBookListResponse(response, page, pageSize);
  }

  const books = searchLocalBooks(params).filter((book) => book.publicStatus === 'public');
  const start = (page - 1) * pageSize;
  const items = books.slice(start, start + pageSize);
  return {
    books: items,
    hasMore: start + pageSize < books.length,
    page,
    pageSize,
    total: books.length,
  };
}

export async function getPendingPublicBooks(signal?: AbortSignal): Promise<Book[]> {
  if (isBackendApiEnabled()) {
    const response = await apiRequest<BackendBookListResponse>('/books/public/pending', { signal });
    return response.items.map(mapBackendBook);
  }

  return [];
}

export async function getBookById(bookId: string, signal?: AbortSignal): Promise<Book | null> {
  if (isBackendApiEnabled()) {
    try {
      return mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}`, { signal }));
    } catch (error: unknown) {
      // Only "book does not exist" maps to null; network or server failures
      // propagate so pages can show an error state instead of a fake 404.
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  const book = ALL_BOOKS.find((b) => b.id === bookId) ?? null;
  return book ? overlayProgressToBook(book) : null;
}

export async function getRecommendedBooks(signal?: AbortSignal): Promise<Book[]> {
  const books = await getBooks(signal);
  return books.filter((book) => !book.disliked && (book.favorite || book.kind === 'manga')).slice(0, 6);
}

export async function searchBooks(params: SearchBooksParams): Promise<Book[]> {
  if (isBackendApiEnabled()) {
    const searchParams = new URLSearchParams({ sort: params.sort ?? 'recent' });

    if (params.q?.trim()) {
      searchParams.set('q', params.q.trim());
    }
    if (params.kind && params.kind !== 'all') {
      searchParams.set('kind', params.kind);
    }
    if (params.tag && params.tag !== '全部') {
      searchParams.set('tag', params.tag);
    }
    if (params.language) {
      searchParams.set('language', params.language);
    }

    return fetchAllBackendBooks('/books', searchParams, params.signal);
  }

  return searchLocalBooks(params);
}

export async function downloadOriginalBookFile(book: Book, signal?: AbortSignal): Promise<void> {
  const scope = getAccountScope();
  const ticket = await apiRequest<{ url: string }>(`/files/books/${book.id}/download-ticket`, { method: 'POST', signal });
  signal?.throwIfAborted();
  assertAccountScope(scope);
  const link = document.createElement('a');
  link.href = buildApiResourceUrl(ticket.url) ?? ticket.url;
  link.download = getDownloadFileName(book);
  document.body.append(link);
  link.click();
  link.remove();
}

export interface AppendBookChapterInput {
  content: string;
  /** Skip title extraction when an editor has already prepared the body. */
  contentIsBody?: boolean;
  title?: string;
}

export interface AppendBookChapterResult {
  chapterCount: number;
  index: number;
  textLength: number;
  title: string;
}

export interface DeleteBookChapterResult {
  chapterCount: number;
  deletedIndex: number;
  nextIndex?: number;
}

export interface EditableBookChapter {
  index: number;
  title: string;
}

export interface EditableBookChapterContent extends EditableBookChapter {
  content: string;
  format: 'epub' | 'text';
  hasImages: boolean;
  revision: string;
}

export async function setBookFavorite(bookId: string, isFavorite: boolean, signal?: AbortSignal): Promise<Book> {
  if (isBackendApiEnabled()) {
    const path = `/books/${bookId}/favorite`;
    const method = isFavorite ? 'POST' : 'DELETE';
    const book = mapBackendBook(await apiRequest<BackendBook>(path, { method, ...(signal ? { signal } : {}) }));
    invalidateBookListCache();
    return book;
  }

  const book = ALL_BOOKS.find((candidate) => candidate.id === bookId);
  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }

  book.favorite = isFavorite;
  return overlayProgressToBook(book);
}

export type BookReadingCompletionResult = Book & { readingProgress?: ReadingProgress };

export async function setBookReadingCompletion(bookId: string, finished: boolean, signal?: AbortSignal): Promise<BookReadingCompletionResult> {
  const scope = getAccountScope();
  const updatedAt = createReadingProgressTimestamp(getPendingReadingProgress(bookId)?.updatedAt, bookId);
  if (isBackendApiEnabled()) {
    // Completion keeps the resume location. Confirm the latest local position
    // first; a reset only needs to supersede it, without waiting for an upload.
    if (finished) {
      try {
        await flushReadingProgressSync(bookId);
      } catch (error) {
        // Replaced editions cannot reuse old coordinates, but may still be
        // marked read using the current format's saved position.
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
    }
    assertAccountScope(scope);
    signal?.throwIfAborted();
    const result = await apiRequest<BackendBook & { reading_progress?: BackendReadingProgress }>(`/books/${bookId}/reading-status`, {
      body: JSON.stringify({ finished, updated_at: updatedAt }),
      method: 'PUT',
      ...(signal ? { signal } : {}),
    });
    assertAccountScope(scope);
    const book = mapBackendBook(result);
    observeReadingProgressTimestamp(bookId, book.updatedAt, scope);
    invalidateBookListCache();
    return { ...book, ...(result.reading_progress ? { readingProgress: mapBackendReadingProgress(result.reading_progress, scope) } : {}) };
  }

  const book = ALL_BOOKS.find((candidate) => candidate.id === bookId);
  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }

  book.progressPercent = finished ? 100 : 0;
  book.lastReadAt = finished ? updatedAt : undefined;
  if (!finished) book.currentChapter = undefined;
  book.updatedAt = updatedAt;
  return { ...overlayProgressToBook(book), progressPercent: finished ? 100 : 0, lastReadAt: book.lastReadAt, ...(!finished ? { currentChapter: undefined } : {}) };
}

export async function updateBook(bookId: string, input: BookUpdateInput, signal?: AbortSignal): Promise<Book> {
  const payload = normalizeBookUpdateInput(input);

  if (isBackendApiEnabled()) {
    const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}`, {
      body: JSON.stringify(toBackendBookUpdateInput(payload)),
      method: 'PATCH',
      ...(signal ? { signal } : {}),
    }));
    invalidateBookListCache();
    return book;
  }

  const book = ALL_BOOKS.find((candidate) => candidate.id === bookId);
  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }

  const { language, ...fields } = payload;
  Object.assign(book, fields);
  if (language !== undefined) {
    book.languageMode = language === 'auto' ? 'auto' : 'manual';
    if (language !== 'auto') book.language = language;
  }
  return overlayProgressToBook(book);
}

export async function setBookDisliked(bookId: string, isDisliked: boolean, signal?: AbortSignal): Promise<Book> {
  if (isBackendApiEnabled()) {
    const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/dislike`, {
      method: isDisliked ? 'POST' : 'DELETE',
      ...(signal ? { signal } : {}),
    }));
    invalidateBookListCache();
    return book;
  }

  const book = ALL_BOOKS.find((candidate) => candidate.id === bookId);
  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }

  book.disliked = isDisliked;
  return overlayProgressToBook(book);
}

export async function syncBookSourceCatalog(bookId: string, signal?: AbortSignal): Promise<SourceCatalogSyncResult> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持同步原作目录');
  }
  const result = await apiRequest<{ catalog_count: number; matched_count: number; renamed_count: number }>(`/books/${bookId}/source-catalog/sync`, {
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
  resetBookCachesAfterCatalogSync();
  return {
    catalogCount: result.catalog_count,
    matchedCount: result.matched_count,
    renamedCount: result.renamed_count,
  };
}

function resetBookCachesAfterCatalogSync(): void {
  invalidateBookListCache();
}

export async function uploadBookCover(bookId: string, file: File, signal?: AbortSignal): Promise<Book> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持修改封面');
  }

  const formData = new FormData();
  formData.append('file', file);
  const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/cover`, {
    body: formData,
    method: 'PUT',
    ...(signal ? { signal } : {}),
  }));
  invalidateBookListCache();
  return book;
}

export async function removeCustomBookCover(bookId: string, signal?: AbortSignal): Promise<Book> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持修改封面');
  }

  const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/cover`, { method: 'DELETE', ...(signal ? { signal } : {}) }));
  invalidateBookListCache();
  return book;
}

export async function deleteBook(bookId: string, signal?: AbortSignal): Promise<void> {
  if (isBackendApiEnabled()) {
    await apiRequest<void>(`/books/${bookId}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
    invalidateBookListCache();
    announceSourceUpdateNotificationsChanged();
    return;
  }

  const book = ALL_BOOKS.find((candidate) => candidate.id === bookId);
  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }

  const index = ALL_BOOKS.indexOf(book);
  ALL_BOOKS.splice(index, 1);
}

export async function checkBookSourceUpdate(bookId: string, signal?: AbortSignal): Promise<Book> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持检查原作更新');
  }
  const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/source-update/check`, { method: 'POST', signal }));
  invalidateBookListCache();
  announceSourceUpdateNotificationsChanged();
  return book;
}

export type SourceUpdateTranslationTask = {
  id: string;
  message: string | null;
  status: 'queued' | 'processing' | 'paused' | 'waiting_quota' | 'review' | 'ready' | 'rejected' | 'failed';
  total_chapters: number;
};

export async function translateBookSourceUpdates(bookId: string, signal?: AbortSignal): Promise<SourceUpdateTranslationTask> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持翻译原作更新');
  }
  const task = await apiRequest<SourceUpdateTranslationTask>(`/books/${bookId}/source-update/translate`, { method: 'POST', signal });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('aisu:translation-jobs-changed'));
  }
  return task;
}

export async function acknowledgeBookSourceUpdate(bookId: string, signal?: AbortSignal): Promise<Book> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持更新提醒');
  }
  const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/source-update/acknowledge`, { method: 'POST', signal }));
  invalidateBookListCache();
  announceSourceUpdateNotificationsChanged();
  return book;
}

export async function acknowledgeAllBookSourceUpdates(signal?: AbortSignal): Promise<void> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持更新提醒');
  }
  await apiRequest<BackendSourceUpdateNotificationList>('/books/source-updates/acknowledge', { method: 'POST', ...(signal ? { signal } : {}) });
  invalidateBookListCache();
  announceSourceUpdateNotificationsChanged();
}

function announceSourceUpdateNotificationsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SOURCE_UPDATE_NOTIFICATIONS_CHANGED_EVENT));
  }
}

export async function appendBookChapter(bookId: string, input: AppendBookChapterInput, signal?: AbortSignal): Promise<AppendBookChapterResult> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持追加章节');
  }
  const result = await chapterMutationRequest<{ chapter_count: number; index: number; text_length: number; title: string }>(`/books/${bookId}/chapters`, {
    body: JSON.stringify({ content: input.content, title: input.title?.trim() || null, ...(input.contentIsBody ? { content_is_body: true } : {}) }),
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
  invalidateBookListCache();
  announceSourceUpdateNotificationsChanged();
  return {
    chapterCount: result.chapter_count,
    index: result.index,
    textLength: result.text_length,
    title: result.title,
  };
}

export async function getEditableBookChapters(bookId: string, signal?: AbortSignal): Promise<EditableBookChapter[]> {
  if (!isBackendApiEnabled()) return [];
  return apiRequest<Array<{ index: number; title: string }>>(`/books/${bookId}/chapters`, { signal });
}

export async function getEditableBookChapter(bookId: string, chapterIndex: number, signal?: AbortSignal): Promise<EditableBookChapterContent> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持编辑章节');
  }
  const chapter = await apiRequest<{ content: string; format: 'epub' | 'text'; has_images: boolean; index: number; title: string; revision: string }>(
    `/books/${bookId}/chapters/${chapterIndex}/edit`,
    signal ? { signal } : undefined,
  );
  return {
    content: chapter.content,
    format: chapter.format,
    hasImages: chapter.has_images,
    revision: chapter.revision,
    index: chapter.index,
    title: chapter.title,
  };
}

export async function updateBookChapter(bookId: string, chapterIndex: number, input: AppendBookChapterInput, signal?: AbortSignal, revision?: string): Promise<AppendBookChapterResult> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持编辑章节');
  }
  if (!revision) throw new ApiError('章节版本缺失，请重新打开编辑器后再试。', 412);
  const result = await chapterMutationRequest<{ chapter_count: number; index: number; text_length: number; title: string }>(`/books/${bookId}/chapters/${chapterIndex}`, {
    body: JSON.stringify({ content: input.content, title: input.title?.trim() || null }),
    method: 'PUT',
    ...(signal ? { signal } : {}),
  }, revision);
  invalidateBookListCache();
  return {
    chapterCount: result.chapter_count,
    index: result.index,
    textLength: result.text_length,
    title: result.title,
  };
}

export async function deleteBookChapter(bookId: string, chapterIndex: number, signal?: AbortSignal, revision?: string): Promise<DeleteBookChapterResult> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持删除章节');
  }
  if (!revision) throw new ApiError('章节版本缺失，请重新打开编辑器后再试。', 412);
  const result = await chapterMutationRequest<{ chapter_count: number; deleted_index: number; next_index: number | null }>(`/books/${bookId}/chapters/${chapterIndex}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  }, revision);
  invalidateBookListCache();
  return {
    chapterCount: result.chapter_count,
    deletedIndex: result.deleted_index,
    nextIndex: result.next_index ?? undefined,
  };
}

export async function requestBookPublicShare(bookId: string, input: BookPublicShareInput = { publicDownloadAllowed: true }, signal?: AbortSignal): Promise<Book> {
  if (isBackendApiEnabled()) {
    const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/share-request`, {
      body: JSON.stringify(toBackendBookPublicShareInput(input)),
      method: 'POST',
      ...(signal ? { signal } : {}),
    }));
    invalidateBookListCache();
    return book;
  }

  const book = ALL_BOOKS.find((candidate) => candidate.id === bookId);
  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }
  book.publicStatus = 'pending';
  book.publicShareNote = normalizeNullableText(input.shareNote ?? null) ?? undefined;
  book.publicSourceNote = normalizeNullableText(input.sourceNote ?? null) ?? undefined;
  book.publicDownloadAllowed = input.publicDownloadAllowed;
  return overlayProgressToBook(book);
}

export async function cancelBookPublicShare(bookId: string, signal?: AbortSignal): Promise<Book> {
  if (isBackendApiEnabled()) {
    const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/share-request`, { method: 'DELETE', ...(signal ? { signal } : {}) }));
    invalidateBookListCache();
    return book;
  }

  const book = ALL_BOOKS.find((candidate) => candidate.id === bookId);
  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }
  book.publicStatus = 'private';
  book.publicShareNote = undefined;
  book.publicSourceNote = undefined;
  book.publicDownloadAllowed = true;
  return overlayProgressToBook(book);
}

export async function approveBookPublicShare(bookId: string, signal?: AbortSignal): Promise<Book> {
  const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/share-request/approve`, { method: 'POST', ...(signal ? { signal } : {}) }));
  invalidateBookListCache();
  return book;
}

export async function rejectBookPublicShare(bookId: string, signal?: AbortSignal): Promise<Book> {
  const book = mapBackendBook(await apiRequest<BackendBook>(`/books/${bookId}/share-request/reject`, { method: 'POST', ...(signal ? { signal } : {}) }));
  invalidateBookListCache();
  return book;
}

function searchLocalBooks(params: SearchBooksParams): Book[] {
  const query = params.q?.trim().toLowerCase() ?? '';
  const booksWithProgress = overlayProgress(ALL_BOOKS);
  const filteredBooks = booksWithProgress.filter((book) => {
    const matchesKind = !params.kind || params.kind === 'all' || book.kind === params.kind;
    const matchesTag = !params.tag || params.tag === '全部' || book.tags.includes(params.tag);
    const matchesLanguage = !params.language || book.language === params.language;
    const searchableText = `${book.title} ${book.subtitle ?? ''} ${book.author} ${book.tags.join(' ')}`.toLowerCase();

    return matchesKind && matchesTag && matchesLanguage && (!query || searchableText.includes(query));
  });

  return sortBooks(filteredBooks, params.sort ?? 'recent');
}

function parseSafeDate(dateStr: string, fallbackStr: string): number {
  const parsed = Date.parse(dateStr);
  if (!isNaN(parsed)) {
    return parsed;
  }
  return Date.parse(fallbackStr);
}

export function sortBooks(books: Book[], sort: BookSortKey): Book[] {
  return [...books].sort((leftBook, rightBook) => {
    if (sort === 'recent') {
      const stateDifference = getRecentReadingState(rightBook) - getRecentReadingState(leftBook);
      if (stateDifference !== 0) {
        return stateDifference;
      }
      const leftTime = parseSafeDate(leftBook.updatedAt, leftBook.createdAt);
      const rightTime = parseSafeDate(rightBook.updatedAt, rightBook.createdAt);
      if (rightTime !== leftTime) {
        return rightTime - leftTime;
      }
      const publicationDifference = Number(rightBook.publicationStatus === 'ongoing') - Number(leftBook.publicationStatus === 'ongoing');
      return publicationDifference || Date.parse(rightBook.createdAt) - Date.parse(leftBook.createdAt);
    }

    if (sort === 'created') {
      return Date.parse(rightBook.createdAt) - Date.parse(leftBook.createdAt);
    }

    if (sort === 'title') {
      return leftBook.title.localeCompare(rightBook.title, 'zh-CN');
    }

    if (sort === 'progress') {
      return rightBook.progressPercent - leftBook.progressPercent;
    }

    if (sort === 'comments') {
      return (rightBook.commentCount ?? 0) - (leftBook.commentCount ?? 0) || parseSafeDate(rightBook.updatedAt, rightBook.createdAt) - parseSafeDate(leftBook.updatedAt, leftBook.createdAt);
    }

    if (sort === 'words') {
      return (rightBook.characterCount ?? 0) - (leftBook.characterCount ?? 0) || parseSafeDate(rightBook.updatedAt, rightBook.createdAt) - parseSafeDate(leftBook.updatedAt, leftBook.createdAt);
    }

    if (sort === 'chapters') {
      return (rightBook.chapterCount ?? 0) - (leftBook.chapterCount ?? 0) || parseSafeDate(rightBook.updatedAt, rightBook.createdAt) - parseSafeDate(leftBook.updatedAt, leftBook.createdAt);
    }

    return 0;
  });
}

function getRecentReadingState(book: Book): number {
  if (hasBookReadingHistory(book) && book.progressPercent < 100) {
    return 2;
  }
  return hasBookReadingHistory(book) ? 0 : 1;
}

function mapBackendBookListResponse(response: BackendBookListResponse, fallbackPage: number, fallbackPageSize: number): BookListResult {
  const page = response.page ?? fallbackPage;
  const pageSize = response.page_size ?? fallbackPageSize;
  return {
    books: response.items.map(mapBackendBook),
    hasMore: response.has_more ?? page * pageSize < response.total,
    page,
    pageSize,
    total: response.total,
  };
}

export function getReaderRouteForBook(book: Book): string {
  if (book.readerType === 'unsupported') {
    return getBookDetailPath(book.id);
  }

  if (book.readerType === 'comic' || book.readerType === 'image') {
    return getMangaReaderPath(book.id);
  }

  return getNovelReaderPath(book.id);
}

function getDownloadFileName(book: Book): string {
  const extension = book.fileExt ?? (book.readerType === 'pdf' ? '.pdf' : '.epub');
  return `${book.title}${extension.startsWith('.') ? extension : `.${extension}`}`;
}

function normalizeBookUpdateInput(input: BookUpdateInput): BookUpdateInput {
  const payload: BookUpdateInput = {};
  if (input.autoTranslateUpdates !== undefined) {
    payload.autoTranslateUpdates = input.autoTranslateUpdates;
  }
  if (input.author !== undefined) {
    payload.author = input.author.trim();
  }
  if (input.description !== undefined) {
    payload.description = input.description.trim();
  }
  if (input.language !== undefined) {
    payload.language = input.language;
  }
  if (input.publicationStatus !== undefined) {
    payload.publicationStatus = input.publicationStatus;
  }
  if (input.seriesKind !== undefined) {
    payload.seriesKind = normalizeNullableText(input.seriesKind);
  }
  if (input.seriesOrder !== undefined) {
    payload.seriesOrder = input.seriesOrder;
  }
  if (input.seriesTitle !== undefined) {
    payload.seriesTitle = normalizeNullableText(input.seriesTitle);
  }
  if (input.sourceUrl !== undefined) {
    payload.sourceUrl = normalizeNullableText(input.sourceUrl);
  }
  if (input.sourceEpisodeCount !== undefined) {
    payload.sourceEpisodeCount = input.sourceEpisodeCount === null ? null : Math.max(0, Math.round(input.sourceEpisodeCount));
  }
  if (input.sourceCharacterCount !== undefined) {
    payload.sourceCharacterCount = input.sourceCharacterCount === null ? null : Math.max(0, Math.round(input.sourceCharacterCount));
  }
  if (input.sourceScheduleTime !== undefined) {
    payload.sourceScheduleTime = normalizeNullableText(input.sourceScheduleTime);
  }
  if (input.sourceScheduleTimezone !== undefined) {
    payload.sourceScheduleTimezone = input.sourceScheduleTimezone;
  }
  if (input.sourceScheduleLabel !== undefined) {
    payload.sourceScheduleLabel = normalizeNullableText(input.sourceScheduleLabel);
  }
  if (input.rating !== undefined) {
    payload.rating = Math.max(0, Math.min(10, input.rating));
  }
  if (input.tags !== undefined) {
    payload.tags = Array.from(new Set(input.tags.map((tag) => tag.trim()).filter(Boolean)));
  }
  if (input.title !== undefined) {
    payload.title = input.title.trim();
  }
  return payload;
}

function normalizeNullableText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.trim() || null;
}

function toBackendBookUpdateInput(input: BookUpdateInput): BackendBookUpdateInput {
  const payload: BackendBookUpdateInput = {};
  if (input.autoTranslateUpdates !== undefined) {
    payload.auto_translate_updates = input.autoTranslateUpdates;
  }
  if (input.author !== undefined) {
    payload.author = input.author;
  }
  if (input.description !== undefined) {
    payload.description = input.description;
  }
  if (input.language !== undefined) {
    payload.language = input.language;
  }
  if (input.publicationStatus !== undefined) {
    payload.publication_status = input.publicationStatus;
  }
  if (input.seriesKind !== undefined) {
    payload.series_kind = input.seriesKind;
  }
  if (input.seriesOrder !== undefined) {
    payload.series_order = input.seriesOrder;
  }
  if (input.seriesTitle !== undefined) {
    payload.series_title = input.seriesTitle;
  }
  if (input.sourceUrl !== undefined) {
    payload.source_url = input.sourceUrl;
  }
  if (input.sourceEpisodeCount !== undefined) {
    payload.source_episode_count = input.sourceEpisodeCount;
  }
  if (input.sourceCharacterCount !== undefined) {
    payload.source_character_count = input.sourceCharacterCount;
  }
  if (input.sourceScheduleTime !== undefined) {
    payload.source_schedule_time = input.sourceScheduleTime;
  }
  if (input.sourceScheduleTimezone !== undefined) {
    payload.source_schedule_timezone = input.sourceScheduleTimezone;
  }
  if (input.sourceScheduleLabel !== undefined) {
    payload.source_schedule_label = input.sourceScheduleLabel;
  }
  if (input.rating !== undefined) {
    payload.rating = input.rating;
  }
  if (input.tags !== undefined) {
    payload.tags = input.tags;
  }
  if (input.title !== undefined) {
    payload.title = input.title;
  }
  return payload;
}

function toBackendBookPublicShareInput(input: BookPublicShareInput): BackendBookPublicShareInput {
  return {
    public_download_allowed: input.publicDownloadAllowed,
    share_note: normalizeNullableText(input.shareNote ?? null),
    source_note: normalizeNullableText(input.sourceNote ?? null),
  };
}
