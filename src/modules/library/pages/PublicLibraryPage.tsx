import { BarChart3, BookOpenText, CalendarDays, Download, LockKeyhole, MessageCircle, UserRound } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNavigationSnapshot } from '../../../shared/navigation/useNavigationSnapshot';
import { useSession } from '../../../app/SessionContext';
import { BookListItem, getPublicBookList, getReaderRouteForBook } from '../../books';
import type { Book, BookKind, BookSortKey } from '../../books';
import { EmptyState } from '../../../shared/components/EmptyState';
import { Button } from '../../../shared/components/Button';
import { Panel } from '../../../shared/components/Panel';
import { HAIRLINE } from '../../../shared/ui';
import { isAbortError } from '../../../shared/utils/abortError';
import { cn } from '../../../shared/utils/cn';
import { formatDate } from '../../../shared/utils/formatDate';
import { PaginatedRequestGate } from '../services/paginatedBookRequests';
import { READING_PROGRESS_SAVED_EVENT } from '../../reading-progress';
import { captureCollectionAnchor, loadBookListWindow } from '../services/bookListRefresh';
import { ShelfListFooter } from '../components/ShelfListFooter';
import { startPolling } from '../../../shared/utils/polling';

const PUBLIC_LIBRARY_PAGE_SIZE = 24;

export function PublicLibraryPage() {
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const navigationSnapshot = useNavigationSnapshot();
  const sortValue = searchParams.get('sort');
  const sort: BookSortKey = ['recent', 'comments', 'chapters', 'words', 'title'].includes(sortValue ?? '') ? sortValue as BookSortKey : 'recent';
  const kindValue = searchParams.get('kind');
  const kind: BookKind | 'all' = ['novel', 'manga', 'pdf', 'image'].includes(kindValue ?? '') ? kindValue as BookKind : 'all';
  const updateFilter = (key: 'kind' | 'sort', value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all' || value === 'recent') next.delete(key); else next.set(key, value);
    setSearchParams(next);
  };
  const [books, setBooks] = useState<Book[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const loadedWindowRef = useRef({ key: '', pages: 0 });
  const restoreRefreshAnchorRef = useRef<(() => void) | null>(null);
  const filterKey = JSON.stringify([session?.id, kind, query, sort]);
  const [loadError, setLoadError] = useState('');
  const [pageError, setPageError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const requestGateRef = useRef(new PaginatedRequestGate());
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    restoreRefreshAnchorRef.current?.();
    restoreRefreshAnchorRef.current = null;
  }, [books]);

  useEffect(() => {
    const refresh = () => {
      requestGateRef.current.abort();
      setReloadKey((current) => current + 1);
    };
    return startPolling(refresh, { immediate: false, events: ['focus', READING_PROGRESS_SAVED_EVENT] });
  }, []);

  useEffect(() => {
    const requestGate = requestGateRef.current;
    const request = requestGate.begin('replace');
    if (!request) {
      return undefined;
    }

    const previousWindow = loadedWindowRef.current;
    const keepContent = previousWindow.key === filterKey && previousWindow.pages > 0;
    setIsLoading(!keepContent);
    setIsRefreshing(keepContent);
    setRefreshError('');
    setIsLoadingMore(false);
    setLoadError('');
    setPageError('');
    if (!keepContent) {
      loadedWindowRef.current = { key: filterKey, pages: 0 };
      restoreRefreshAnchorRef.current = null;
      setHasMore(false);
      setPage(1);
      setTotal(0);
      setBooks([]);
    }
    void loadBookListWindow(
      (page) => getPublicBookList({ kind, page, pageSize: PUBLIC_LIBRARY_PAGE_SIZE, q: query, signal: request.signal, sort }),
      keepContent ? previousWindow.pages : 1,
      request.signal,
    )
      .then((result) => {
        if (!requestGate.isCurrent(request.id)) {
          return;
        }
        if (keepContent) restoreRefreshAnchorRef.current = captureCollectionAnchor('.public-library-page');
        loadedWindowRef.current = { key: filterKey, pages: result.page };
        setBooks(result.books);
        setHasMore(result.hasMore);
        setPage(result.page);
        setTotal(result.total);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error) && requestGate.isCurrent(request.id)) {
          const message = error instanceof Error ? error.message : '公共书库加载失败';
          if (keepContent) setRefreshError(message);
          else setLoadError(message);
        }
      })
      .finally(() => {
        if (requestGate.isCurrent(request.id)) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
        requestGate.complete(request.id, 'replace');
      });

    return () => {
      requestGate.abort();
    };
  }, [filterKey, kind, query, reloadKey, session?.id, sort]);

  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    next.delete('kind');
    setSearchParams(next);
  };
  const summary = useMemo(() => getPublicLibrarySummary(books), [books]);

  const handleLoadMore = useCallback(async () => {
    if (isLoading || isRefreshing || refreshError || isLoadingMore || !hasMore) {
      return;
    }

    const request = requestGateRef.current.begin('append');
    if (!request) {
      return;
    }

    setIsLoadingMore(true);
    setPageError('');
    try {
      const result = await getPublicBookList({ kind, page: page + 1, pageSize: PUBLIC_LIBRARY_PAGE_SIZE, q: query, signal: request.signal, sort });
      if (!requestGateRef.current.isCurrent(request.id)) {
        return;
      }
      // Offset pages can shift when books are approved, withdrawn or reordered.
      // Reload instead of silently skipping books or retaining withdrawn entries.
      if (result.total !== total || result.books.some((book) => books.some((loaded) => loaded.id === book.id))) {
        requestGateRef.current.abort();
        setReloadKey((current) => current + 1);
        return;
      }
      setBooks((currentBooks) => mergeBooksById(currentBooks, result.books));
      setHasMore(result.hasMore);
      setPage(result.page);
      loadedWindowRef.current = { key: filterKey, pages: result.page };
      setTotal(result.total);
    } catch (error: unknown) {
      if (isAbortError(error) || !requestGateRef.current.isCurrent(request.id)) {
        return;
      }
      setPageError(error instanceof Error ? error.message : '下一页加载失败');
    } finally {
      if (requestGateRef.current.isCurrent(request.id)) {
        setIsLoadingMore(false);
      }
      requestGateRef.current.complete(request.id, 'append');
    }
  }, [books, filterKey, hasMore, isLoading, isRefreshing, refreshError, isLoadingMore, kind, page, query, sort, total, setBooks, setHasMore, setIsLoadingMore]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !hasMore || isLoading || isLoadingMore || pageError) return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      void handleLoadMore();
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void handleLoadMore();
      }
    }, { rootMargin: '800px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleLoadMore, hasMore, isLoading, isLoadingMore, pageError]);

  useEffect(() => {
    if (navigationSnapshot && page < navigationSnapshot.pages && hasMore && !isLoading && !isLoadingMore && !pageError) void handleLoadMore();
  }, [navigationSnapshot, page, hasMore, isLoading, isLoadingMore, pageError, handleLoadMore]);

  return (
    <Panel className="public-library-page" data-navigation-pages={page} data-navigation-has-more={hasMore} data-navigation-loading={isLoading || isRefreshing || isLoadingMore || (page < (navigationSnapshot?.pages ?? 1) && hasMore && !pageError && !refreshError)}>
      <div className="mb-4 sm:mb-5">
        <h1 className="app-page-title font-display text-3xl font-semibold text-stone-950 sm:text-4xl dark:text-night-ink">公共书库</h1>
        {query.trim() && <p title={query.trim()} className="mt-2 line-clamp-2 break-words text-sm text-stone-500 dark:text-stone-400">搜索“{query.trim()}”</p>}
      </div>

      <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-y py-2.5', HAIRLINE)}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums text-ink/70 dark:text-night-soft">
          {!isLoading && !loadError && books.length > 0 && (
            <>
              <span>{getBookCountLabel(books.length, total)}</span>
              <SummaryDot />
              <span>{summary.chapterLabel}章节</span>
              <SummaryDot />
              <span>{summary.wordLabel}字</span>
              <SummaryDot />
              <span>{summary.commentCount} 条评论</span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-ink/55 dark:text-stone-400">
            类型
            <select className="min-h-10 rounded-full border-0 bg-stone-100 px-3 text-xs text-stone-600 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 dark:bg-white/5 dark:text-night-copy" onChange={(event) => updateFilter('kind', event.target.value)} value={kind}>
              <option className="dark:bg-night" value="all">全部</option>
              <option className="dark:bg-night" value="novel">小说</option>
              <option className="dark:bg-night" value="manga">漫画</option>
              <option className="dark:bg-night" value="pdf">PDF</option>
              <option className="dark:bg-night" value="image">图片</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink/55 dark:text-stone-400">
            排序
            <select
              className="min-h-10 rounded-full border-0 bg-stone-100 px-3 text-xs text-stone-600 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 dark:bg-white/5 dark:text-night-copy"
              onChange={(event) => updateFilter('sort', event.target.value)}
              value={sort}
            >
              <option className="dark:bg-night" value="recent">最近更新</option>
              <option className="dark:bg-night" value="comments">评论最多</option>
              <option className="dark:bg-night" value="chapters">章节最多</option>
              <option className="dark:bg-night" value="words">字数最多</option>
              <option className="dark:bg-night" value="title">书名</option>
            </select>
          </label>
        </div>
      </div>

      {loadError && !isLoading ? (
        <div className="mt-6"><EmptyState title="公共书库加载失败" description={loadError} action={<Button onClick={() => setReloadKey((key) => key + 1)}>重试</Button>} /></div>
      ) : isLoading ? (
        <div className="mt-6">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className={cn('flex gap-4 border-b py-4', HAIRLINE)} key={index}>
              <div className="h-24 w-16 shrink-0 animate-pulse rounded-lg bg-stone-900/5 dark:bg-white/[0.05]" />
              <div className="min-w-0 flex-1 space-y-2.5 py-1">
                <div className="h-4 w-1/2 animate-pulse rounded bg-stone-900/5 dark:bg-white/[0.05]" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-stone-900/5 dark:bg-white/[0.05]" />
                <div className="mt-3 h-1.5 w-full max-w-md animate-pulse rounded-full bg-stone-900/5 dark:bg-white/[0.05]" />
              </div>
            </div>
          ))}
        </div>
      ) : books.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title={query.trim() ? '没有找到相关图书' : kind !== 'all' ? '这个分类暂无图书' : '公共书库还没有书'}
            description={query.trim() ? '试试其他书名或作者，或清除筛选条件。' : kind !== 'all' ? '可以查看其他分类的公开图书。' : '通过审核的公开图书会显示在这里。'}
            action={query.trim() || kind !== 'all' ? <Button onClick={clearFilters}>查看全部公开图书</Button> : undefined}
          />
        </div>
      ) : (
        <>
          <div className="public-book-list mt-6 space-y-3">
            {books.map((book) => (
              <PublicBookListItem book={book} key={book.id} />
            ))}
          </div>

        </>
      )}
      {!isLoading && !loadError && (books.length > 0 || isRefreshing || refreshError) && <ShelfListFooter
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        isRefreshing={isRefreshing}
        onLoadMore={() => void handleLoadMore()}
        onRetryRefresh={() => setReloadKey((key) => key + 1)}
        pageError={pageError}
        refreshError={refreshError}
        sentinelRef={loadMoreSentinelRef}
      />}
    </Panel>
  );
}

function mergeBooksById(currentBooks: Book[], nextBooks: Book[]): Book[] {
  const seenBookIds = new Set(currentBooks.map((book) => book.id));
  return [...currentBooks, ...nextBooks.filter((book) => !seenBookIds.has(book.id))];
}

function getBookCountLabel(loadedCount: number, total: number): string {
  if (total > loadedCount) {
    return `已显示 ${loadedCount}/${total} 本`;
  }
  return `${loadedCount} 本公开图书`;
}

function PublicBookListItem({ book }: { book: Book }) {
  const metadata = [
    book.ownerNickname ? { icon: UserRound, label: book.ownerNickname } : null,
    book.lastContentUpdatedAt ? { icon: CalendarDays, label: `更新 ${formatDate(book.lastContentUpdatedAt)}` } : book.publicApprovedAt ? { icon: CalendarDays, label: `公开 ${formatDate(book.publicApprovedAt)}` } : null,
    getResourceLabel(book) ? { icon: BookOpenText, label: getResourceLabel(book) } : null,
    book.characterCount ? { icon: BarChart3, label: formatCharacterCount(book.characterCount) } : null,
    { icon: MessageCircle, label: `${book.commentCount ?? 0} 条评论` },
    book.publicDownloadAllowed === false ? { icon: LockKeyhole, label: '仅在线阅读' } : { icon: Download, label: '可下载' },
  ].filter(Boolean) as Array<{ icon: typeof UserRound; label: string }>;

  return (
    <BookListItem
      book={book}
      footer={(
        <>
          <div className="flex flex-wrap gap-2">
            {metadata.map((item) => {
              const Icon = item.icon;
              return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-white/[0.06] dark:text-night-soft" key={item.label}>
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </span>
              );
            })}
          </div>
          {(book.publicShareNote || book.publicSourceNote) && (
            <div className="mt-3 space-y-1 text-sm leading-6 text-stone-500 dark:text-stone-400">
              {book.publicShareNote && <p className="line-clamp-2">{book.publicShareNote}</p>}
              {book.publicSourceNote && <p className="line-clamp-1 text-xs opacity-75">来源：{book.publicSourceNote}</p>}
            </div>
          )}
        </>
      )}
      readerPath={getReaderRouteForBook(book)}
    />
  );
}

function SummaryDot() {
  return (
    <span aria-hidden className="text-ink/25 dark:text-stone-600">
      ·
    </span>
  );
}

function getPublicLibrarySummary(books: Book[]) {
  const chapterCount = books.reduce((total, book) => total + (book.chapterCount ?? 0), 0);
  const wordCount = books.reduce((total, book) => total + (book.characterCount ?? 0), 0);
  const commentCount = books.reduce((total, book) => total + (book.commentCount ?? 0), 0);
  return {
    chapterLabel: chapterCount > 0 ? String(chapterCount) : '0',
    commentCount,
    wordLabel: formatCharacterCount(wordCount),
  };
}

function getResourceLabel(book: Book): string | null {
  if (book.chapterCount) {
    return `${book.chapterCount} 章`;
  }
  if (book.pageCount) {
    return `${book.pageCount} 页`;
  }
  return null;
}

function formatCharacterCount(count: number): string {
  if (count >= 10000) {
    return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)} 万`;
  }
  return String(count);
}
