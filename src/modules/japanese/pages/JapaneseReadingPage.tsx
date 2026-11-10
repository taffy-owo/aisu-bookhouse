import { hasBookReadingHistory } from '../../books/services/bookProgress';
import { ArrowRight, Check, Languages, Upload } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useSession } from '../../../app/SessionContext';
import { ROUTES, getBookDetailPath } from '../../../config/routes';
import { Button } from '../../../shared/components/Button';
import { EmptyState } from '../../../shared/components/EmptyState';
import { Panel } from '../../../shared/components/Panel';
import { ProgressBar } from '../../../shared/components/ProgressBar';
import { HAIRLINE } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';
import { BookCover, getBookList, getBrowserReaderAvailability, type Book, type SearchBooksParams } from '../../books';
import { BookGrid } from '../../library/components/BookGrid';
import { BookShelfSkeleton } from '../../library/components/BookShelfSkeleton';
import { InlineJapaneseReadingWorkspace } from '../components/InlineJapaneseReadingWorkspace';
import { type JapaneseShelfFilter } from '../services/japaneseBooks';
import { startPolling } from '../../../shared/utils/polling';
import { READING_PROGRESS_SAVED_EVENT } from '../../reading-progress';
import { TRANSLATED_BOOKS_CHANGED_EVENT } from '../../uploads/services/wholeBookTranslationService';
import { captureCollectionAnchor, loadBookListWindow } from '../../library/services/bookListRefresh';
import { ShelfListFooter } from '../../library/components/ShelfListFooter';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { useNavigationSnapshot } from '../../../shared/navigation/useNavigationSnapshot';

const PAGE_SIZE = 36;
const shelfFor = (filter: JapaneseShelfFilter): SearchBooksParams['shelf'] => (
  filter === 'reading' ? 'recent' : filter === 'all' ? 'all' : filter
);

const filters: Array<{ label: string; value: JapaneseShelfFilter }> = [
  { label: '全部', value: 'all' },
  { label: '阅读中', value: 'reading' },
  { label: '未开始', value: 'unread' },
  { label: '已读完', value: 'finished' },
];

export function JapaneseReadingPage() {
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationSnapshot = useNavigationSnapshot();
  const filter = filters.find((item) => item.value === searchParams.get('shelf'))?.value ?? 'all';
  const query = searchParams.get('q')?.trim() ?? '';
  const updateShelfFilter = (value: JapaneseShelfFilter) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('shelf');
    else next.set('shelf', value);
    setSearchParams(next);
  };
  const clearShelfFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    next.delete('shelf');
    setSearchParams(next);
  };
  const [books, setBooks] = useState<Book[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pageError, setPageError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const loadedWindowRef = useRef({ key: '', pages: 0 });
  const restoreRefreshAnchorRef = useRef<(() => void) | null>(null);
  const filterKey = JSON.stringify([session?.id, filter, query]);
  const requestIdRef = useRef(0);
  const appendControllerRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    restoreRefreshAnchorRef.current?.();
    restoreRefreshAnchorRef.current = null;
  }, [books]);

  useEffect(() => startPolling(() => setReloadKey((key) => key + 1), {
    immediate: false, events: ['focus', READING_PROGRESS_SAVED_EVENT, TRANSLATED_BOOKS_CHANGED_EVENT],
  }), []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    appendControllerRef.current?.abort();
    appendControllerRef.current = null;
    const previousWindow = loadedWindowRef.current;
    const keepContent = previousWindow.key === filterKey && previousWindow.pages > 0;
    setIsLoading(!keepContent);
    setIsRefreshing(keepContent);
    setIsLoadingMore(false);
    setLoadError('');
    setPageError('');
    setRefreshError('');
    if (!keepContent) {
      loadedWindowRef.current = { key: filterKey, pages: 0 };
      restoreRefreshAnchorRef.current = null;
      setBooks([]);
      setPage(1);
      setTotal(0);
      setHasMore(false);
    }
    void loadBookListWindow(
      (page) => getBookList({ language: 'ja', q: query, shelf: shelfFor(filter), page, pageSize: PAGE_SIZE, signal: controller.signal }),
      keepContent ? previousWindow.pages : navigationSnapshot?.pages ?? 1,
      controller.signal,
    )
      .then((result) => {
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        if (keepContent) restoreRefreshAnchorRef.current = captureCollectionAnchor('.japanese-shelf');
        loadedWindowRef.current = { key: filterKey, pages: result.page };
        setBooks(result.books);
        setPage(result.page);
        setTotal(result.total);
        setHasMore(result.hasMore);
      })
      .catch((error: unknown) => {
        if (requestId === requestIdRef.current && !controller.signal.aborted) {
          const message = error instanceof Error ? error.message : '日文书架加载失败';
          if (keepContent) setRefreshError(message);
          else setLoadError(message);
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      });
    return () => {
      controller.abort();
      appendControllerRef.current?.abort();
      requestIdRef.current += 1;
    };
  }, [filter, filterKey, navigationSnapshot?.pages, query, reloadKey, session?.id]);

  const continueBook = filter === 'all' && !query
    ? books.find((book) => hasBookReadingHistory(book) && book.progressPercent < 100) ?? books[0]
    : null;

  const loadNextPage = () => {
    if (!hasMore || isLoading || isRefreshing || refreshError || isLoadingMore || appendControllerRef.current) return;
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    appendControllerRef.current = controller;
    setIsLoadingMore(true);
    setPageError('');
    void getBookList({ language: 'ja', q: query, shelf: shelfFor(filter), page: page + 1, pageSize: PAGE_SIZE, signal: controller.signal })
      .then(async (result) => {
        const isCurrent = () => requestId === requestIdRef.current && !controller.signal.aborted;
        if (!isCurrent()) return;
        let nextBooks = [...books, ...result.books];
        if (result.total !== total || result.books.some((book) => books.some((loaded) => loaded.id === book.id))) {
          // Rebuild the requested range before replacing it. An offset shift
          // must not hide a book or collapse the shelf back to its first page.
          const params = { language: 'ja' as const, q: query, shelf: shelfFor(filter), pageSize: PAGE_SIZE, signal: controller.signal };
          result = await getBookList({ ...params, page: 1 });
          if (!isCurrent()) return;
          nextBooks = result.books;
          for (let nextPage = 2; nextPage <= page + 1 && result.hasMore; nextPage += 1) {
            const next = await getBookList({ ...params, page: nextPage });
            if (!isCurrent()) return;
            if (next.total !== result.total || next.books.some((book) => nextBooks.some((loaded) => loaded.id === book.id))) {
              throw new Error('日文书架仍在更新，请重试加载。');
            }
            nextBooks = [...nextBooks, ...next.books];
            result = next;
          }
        }
        setBooks(nextBooks);
        loadedWindowRef.current = { key: filterKey, pages: result.page };
        setPage(result.page);
        setTotal(result.total);
        setHasMore(result.hasMore);
      })
      .catch((error: unknown) => {
        if (requestId === requestIdRef.current && !controller.signal.aborted) {
          setPageError(error instanceof Error ? error.message : '加载下一页失败');
        }
      })
      .finally(() => {
        if (appendControllerRef.current === controller) appendControllerRef.current = null;
        if (requestId === requestIdRef.current) setIsLoadingMore(false);
      });
  };

  return (
    <Panel className="japanese-page" data-navigation-pages={page} data-navigation-has-more={hasMore} data-navigation-loading={isLoading || isRefreshing || isLoadingMore}>
      <header className={cn('japanese-page-header flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between', HAIRLINE)}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-accent dark:text-peach lg:hidden">
            <Languages className="h-4 w-4" />
            日文阅读
          </div>
          <h1 className="app-page-title mt-2 lg:mt-0 font-display text-3xl font-semibold text-stone-950 dark:text-night-ink">日文阅读</h1>
          <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">粘贴原文，立即在当前页面阅读。</p>
        </div>
        <Link className="japanese-page-action inline-flex min-h-10 shrink-0 items-center justify-center gap-2 self-start rounded-lg border border-ink/[0.08] bg-white/45 px-3 py-2 text-sm font-medium text-stone-600 transition hover:bg-white/75 dark:border-white/10 dark:bg-white/[0.04] dark:text-night-soft dark:hover:bg-white/[0.07] sm:self-auto" to={ROUTES.upload}>
          <Upload className="h-4 w-4" />上传日文书
        </Link>
      </header>

      <div className="japanese-start-row">
        <InlineJapaneseReadingWorkspace key={session?.id ?? 'anonymous'} onImported={() => setReloadKey((key) => key + 1)} />
        {!loadError && !isLoading && continueBook && <ContinueJapaneseBook book={continueBook} />}
      </div>

      <section className="japanese-shelf mt-9 sm:mt-11 lg:mt-5">
        <div className="japanese-shelf-heading flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium text-stone-400">我的日文书</p>
            <h2 className="mt-1 font-display text-2xl font-semibold text-stone-950 sm:text-3xl lg:text-xl dark:text-night-ink">书架</h2>
          </div>
          {query && <p title={query} className="line-clamp-2 min-w-0 break-words text-sm text-stone-500 dark:text-stone-400">搜索“{query}”</p>}
        </div>

        <div className={cn('japanese-shelf-filters mt-5 lg:mt-3 flex gap-1 overflow-x-auto border-y py-2', HAIRLINE)}>
          {filters.map((item) => (
            <button
              className={cn('japanese-shelf-tab min-h-10 shrink-0 px-4 py-2 text-sm transition', filter === item.value ? 'is-active' : '')}
              aria-pressed={filter === item.value}
              key={item.value}
              onClick={() => updateShelfFilter(item.value)}
              type="button"
            >
              {item.label}
            </button>
          ))}
          <span className="japanese-shelf-count ml-auto flex shrink-0 items-center gap-1 px-2 text-xs tabular-nums text-stone-400">{isLoading ? '加载中…' : <><Check className="h-3.5 w-3.5" />{total} 本</>}</span>
        </div>

        {loadError ? (
          <div className="mt-8"><EmptyState action={<Button onClick={() => setReloadKey((key) => key + 1)}>重试</Button>} description={loadError} title="日文书架加载失败" /></div>
        ) : isLoading ? (
          <div className="mt-6 lg:mt-4"><BookShelfSkeleton count={7} /></div>
        ) : !books.length && filter === 'all' && !query ? (
          <section className={cn('japanese-empty-shelf mt-9 flex items-center justify-between gap-4 border-t pt-6', HAIRLINE)}>
            <div>
              <h2 className="font-display text-xl font-semibold text-stone-950 dark:text-night-ink">我的日文书</h2>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">保存过的文章会出现在这里。</p>
            </div>
            <Link className="japanese-page-action inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm text-accent transition hover:bg-accent/[0.07] dark:text-peach" to={ROUTES.library}>
              打开我的书架 <ArrowRight className="h-4 w-4" />
            </Link>
          </section>
        ) : books.length ? (
          <div className="mt-6 lg:mt-4 space-y-5">
            <BookGrid books={books} />
          </div>
        ) : (
          <EmptyState
            action={<Button onClick={clearShelfFilters} variant="secondary">查看全部日文书</Button>}
            description={query ? '试试其他书名或作者，或清除筛选条件。' : '可以切换阅读状态，或查看全部日文书。'}
            title={query ? '没有找到相关日文书' : '这个分类暂时没有书'}
          />
        )}
        {!loadError && !isLoading && (books.length > 0 || isRefreshing || refreshError) && <ShelfListFooter
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          isRefreshing={isRefreshing}
          refreshError={refreshError}
          pageError={pageError}
          sentinelRef={null}
          onLoadMore={loadNextPage}
          onRetryRefresh={() => setReloadKey((key) => key + 1)}
        />}
      </section>
    </Panel>
  );
}

function ContinueJapaneseBook({ book }: { book: Book }) {
  const navigationState = createCollectionLinkState(useLocation());
  const availability = getBrowserReaderAvailability(book);
  return (
    <section className="japanese-continue relative mt-8 lg:mt-4 overflow-hidden border-y border-ink/[0.08] py-5 dark:border-white/[0.1] sm:py-6 lg:py-4">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_75%_40%,rgba(243,111,108,0.10),transparent_58%)] dark:bg-[radial-gradient(circle_at_75%_40%,rgba(255,185,170,0.07),transparent_58%)]" />
      <div className="relative flex items-center gap-5 sm:gap-7 lg:gap-3">
        <Link className="w-16 shrink-0" state={navigationState} to={getBookDetailPath(book.id)}><BookCover book={book} size="sm" /></Link>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-accent dark:text-peach">{availability.canReadInBrowser ? (hasBookReadingHistory(book) ? '继续阅读' : '待阅读') : '我的日文书'}</p>
          <h2 className="mt-2 line-clamp-2 font-display text-xl font-semibold leading-snug text-stone-950 sm:text-3xl lg:text-xl dark:text-night-ink">{book.title}</h2>
          <p className="mt-1 truncate text-sm text-stone-500 dark:text-stone-400" title={book.author?.trim() || '佚名'}>{book.author?.trim() || '佚名'}</p>
          <ProgressBar className="mt-5" value={book.progressPercent} />
          <Link className="japanese-page-action mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:gap-3 hover:bg-accent-deep" title={availability.reason} state={navigationState} to={availability.entryPath}>
            {availability.canReadInBrowser ? (hasBookReadingHistory(book) ? '继续读' : '开始阅读') : '查看详情'} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
