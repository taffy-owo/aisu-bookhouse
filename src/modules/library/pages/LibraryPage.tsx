import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Circle, Heart, Layers3, Share2, ThumbsDown, Trash2, Undo2, X } from 'lucide-react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useSession } from '../../../app/SessionContext';
import { Button } from '../../../shared/components/Button';
import { EmptyState } from '../../../shared/components/EmptyState';
import { Panel } from '../../../shared/components/Panel';
import { LinkButton } from '../../../shared/components/LinkButton';
import { ROUTES } from '../../../config/routes';
import { HAIRLINE } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';
import { BookListItem, cancelBookPublicShare, deleteBook, getBookList, getReaderRouteForBook, requestBookPublicShare, setBookDisliked, setBookFavorite, setBookReadingCompletion, updateBook } from '../../books';
import type { Book, BookKind } from '../../books';
import { BookGrid } from '../components/BookGrid';
import { BookShelfSkeleton } from '../components/BookShelfSkeleton';
import { BulkSeriesDialog, type BulkSeriesSaveInput } from '../components/BulkSeriesDialog';
import { BookSeriesListGroup } from '../components/BookSeriesShelfItem';
import { DeleteBookDialog } from '../components/DeleteBookDialog';
import { LibraryFilters } from '../components/LibraryFilters';
import { createLibrarySearchParams, parseLibraryFilters } from '../services/libraryFilters';
import { groupBooksForLibraryShelf } from '../services/bookSeries';
import { PaginatedRequestGate } from '../services/paginatedBookRequests';
import { isAbortError } from '../../../shared/utils/abortError';
import { useNavigationSnapshot } from '../../../shared/navigation/useNavigationSnapshot';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { TRANSLATED_BOOKS_CHANGED_EVENT } from '../../uploads/services/wholeBookTranslationService';
import { READING_PROGRESS_SAVED_EVENT } from '../../reading-progress';
import { captureCollectionAnchor, loadBookListWindow } from '../services/bookListRefresh';
import { ShelfListFooter } from '../components/ShelfListFooter';
import { startPolling } from '../../../shared/utils/polling';

const BOOK_PAGE_SIZE = 36;

export function LibraryPage() {
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigationSnapshot = useNavigationSnapshot();
  const [books, setBooks] = useState<Book[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const loadedWindowRef = useRef({ key: '', pages: 0 });
  const restoreRefreshAnchorRef = useRef<(() => void) | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageError, setPageError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const view = searchParams.get('view') === 'list' ? 'list' : 'grid';
  const setView = (value: 'grid' | 'list') => {
    const next = new URLSearchParams(searchParams);
    if (value === 'list') next.set('view', value); else next.delete('view');
    setSearchParams(next, { replace: true, state: location.state });
  };
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [bulkMessage, setBulkMessage] = useState('');
  const [bulkOperation, setBulkOperation] = useState<string | null>(null);
  const [isBulkShareDialogOpen, setIsBulkShareDialogOpen] = useState(false);
  const [isBulkSeriesDialogOpen, setIsBulkSeriesDialogOpen] = useState(false);
  const [bulkShareAllowsDownload, setBulkShareAllowsDownload] = useState(false);
  const [bulkShareError, setBulkShareError] = useState('');
  const [bookPendingDelete, setBookPendingDelete] = useState<Book | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState('');
  const [selectedBookIds, setSelectedBookIds] = useState<Set<string>>(() => new Set());
  const [expandedListSeriesKey, setExpandedListSeriesKey] = useState<string | null | undefined>(undefined);
  const [loadedShelfKey, setLoadedShelfKey] = useState<string | null>(null);
  const shelfLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const requestGateRef = useRef(new PaginatedRequestGate());
  const mutationControllersRef = useRef(new Set<AbortController>());
  const mutationGenerationRef = useRef(0);
  const pendingBookActionsRef = useRef(new Map<string, AbortController>());
  const [pendingBookActionIds, setPendingBookActionIds] = useState<Set<string>>(() => new Set());
  const [isShelfRefreshPending, setIsShelfRefreshPending] = useState(false);
  const [isShelfPaginationStale, setIsShelfPaginationStale] = useState(false);
  const holdsShelfRefresh = pendingBookActionIds.size > 0 || bulkOperation !== null || isDeleting || bookPendingDelete !== null
    || isBulkDeleteDialogOpen || isBulkShareDialogOpen || isBulkSeriesDialogOpen
    || (isBulkMode && selectedBookIds.size > 0);
  const queueShelfRefresh = useCallback(() => setIsShelfRefreshPending(true), []);
  const invalidateShelf = useCallback(() => {
    setIsShelfPaginationStale(true);
    setIsShelfRefreshPending(true);
  }, []);
  const filters = useMemo(() => parseLibraryFilters(searchParams), [searchParams]);
  const activeKind = filters.kind;
  const query = filters.query;
  const sort = filters.sort;
  const searchableKind = ['novel', 'manga', 'pdf', 'image'].includes(activeKind) ? (activeKind as BookKind) : 'all';
  const shelf = ['favorite', 'recent', 'finished', 'unread', 'disliked'].includes(activeKind)
    ? (activeKind as 'favorite' | 'recent' | 'finished' | 'unread' | 'disliked') : 'all';
  const shelfKey = useMemo(() => JSON.stringify({ kind: searchableKind, q: query, sort, shelf, reloadKey }), [query, reloadKey, searchableKind, shelf, sort]);
  const shelfFilterKey = JSON.stringify([session?.id, searchableKind, query, sort, shelf]);

  useLayoutEffect(() => {
    restoreRefreshAnchorRef.current?.();
    restoreRefreshAnchorRef.current = null;
  }, [books]);

  const deferShelfRefreshForAction = () => {
    if (!isRefreshing) return;
    requestGateRef.current.abort();
    setIsRefreshing(false);
    setLoadedShelfKey(shelfKey);
    invalidateShelf();
  };

  const beginMutation = () => {
    const controller = new AbortController();
    mutationControllersRef.current.add(controller);
    return { controller, generation: mutationGenerationRef.current };
  };

  const isCurrentMutation = (mutation: { controller: AbortController; generation: number }) => (
    !mutation.controller.signal.aborted && mutation.generation === mutationGenerationRef.current
  );

  const finishMutation = (mutation: { controller: AbortController }) => {
    mutationControllersRef.current.delete(mutation.controller);
  };

  useEffect(() => {
    const mutationControllers = mutationControllersRef.current;
    const pendingBookActions = pendingBookActionsRef.current;
    mutationGenerationRef.current += 1;
    setPendingBookActionIds(new Set());
    setBulkOperation(null);
    setIsDeleting(false);
    setBookPendingDelete(null);
    setIsBulkDeleteDialogOpen(false);
    setIsBulkShareDialogOpen(false);
    setIsBulkSeriesDialogOpen(false);
    setIsShelfRefreshPending(false);
    setIsShelfPaginationStale(false);
    return () => {
      mutationGenerationRef.current += 1;
      mutationControllers.forEach((controller) => controller.abort());
      mutationControllers.clear();
      pendingBookActions.clear();
    };
  }, [query, reloadKey, searchableKind, session?.id, shelf, sort]);

  useEffect(() => {
    window.addEventListener(TRANSLATED_BOOKS_CHANGED_EVENT, invalidateShelf);
    window.addEventListener(READING_PROGRESS_SAVED_EVENT, invalidateShelf);
    const stopResume = startPolling(queueShelfRefresh, { immediate: false, events: ['focus'] });
    return () => {
      window.removeEventListener(TRANSLATED_BOOKS_CHANGED_EVENT, invalidateShelf);
      window.removeEventListener(READING_PROGRESS_SAVED_EVENT, invalidateShelf);
      stopResume();
    };
  }, [invalidateShelf, queueShelfRefresh]);

  useEffect(() => {
    if (!isShelfRefreshPending || holdsShelfRefresh) return;
    // Keep selection, retry drafts and in-flight mutations until the user finishes.
    requestGateRef.current.abort();
    setIsShelfRefreshPending(false);
    setReloadKey((current) => current + 1);
  }, [holdsShelfRefresh, isShelfRefreshPending]);

  useEffect(() => {
    const requestGate = requestGateRef.current;
    const request = requestGate.begin('replace');
    if (!request) {
      return undefined;
    }

    const previousWindow = loadedWindowRef.current;
    const keepContent = previousWindow.key === shelfFilterKey && previousWindow.pages > 0;
    setIsLoading(!keepContent);
    setIsRefreshing(keepContent);
    setRefreshError('');
    setIsLoadingMore(false);
    setLoadError('');
    setPageError('');
    if (!keepContent) {
      loadedWindowRef.current = { key: shelfFilterKey, pages: 0 };
      restoreRefreshAnchorRef.current = null;
      setBooks([]);
      setLoadedShelfKey(null);
      setPage(1);
      setTotal(0);
      setHasMore(false);
      setSelectedBookIds(new Set());
    }
    void loadBookListWindow(
      (page) => getBookList({ kind: searchableKind, q: query, signal: request.signal, sort, shelf, page, pageSize: BOOK_PAGE_SIZE }),
      keepContent ? previousWindow.pages : 1,
      request.signal,
    )
      .then((result) => {
        if (requestGate.isCurrent(request.id)) {
          if (keepContent) restoreRefreshAnchorRef.current = captureCollectionAnchor('.library-page');
          loadedWindowRef.current = { key: shelfFilterKey, pages: result.page };
          setBooks(result.books);
          setPage(result.page);
          setTotal(result.total);
          setHasMore(result.hasMore);
          setLoadedShelfKey(shelfKey);
        }
      })
      .catch((error: unknown) => {
        if (!isAbortError(error) && requestGate.isCurrent(request.id)) {
          const message = error instanceof Error && error.message ? error.message : '书架加载失败';
          if (keepContent) {
            setRefreshError(message);
            setLoadedShelfKey(shelfKey);
          }
          else {
            setBooks([]);
            setLoadError(message);
          }
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
  }, [query, reloadKey, searchableKind, session?.id, shelf, shelfKey, shelfFilterKey, sort]);

  const updateFilters = (nextFilters: Partial<Parameters<typeof createLibrarySearchParams>[0]>) => {
    const mergedFilters = {
      kind: activeKind,
      query,
      sort,
      ...nextFilters,
    };
    const next = createLibrarySearchParams(mergedFilters);
    if (view === 'list') next.set('view', 'list');
    setSearchParams(next);
  };

  const visibleBooks = books;
  const shelfItems = useMemo(
    () => isBulkMode
      ? visibleBooks.map((book) => ({ book, kind: 'book' as const }))
      : groupBooksForLibraryShelf(visibleBooks),
    [isBulkMode, visibleBooks],
  );
  const displayedShelfItems = shelfItems;
  const restoredSeries = shelfItems.find((item) => item.kind === 'series' && item.books.some((book) => book.id === navigationSnapshot?.expandedSeriesBookId));
  const restoredListSeriesKey = restoredSeries?.kind === 'series' ? restoredSeries.key : null;
  const activeListSeriesKey = expandedListSeriesKey === undefined ? restoredListSeriesKey : expandedListSeriesKey;
  const displayedBooks = visibleBooks;
  const hasMoreShelfItems = hasMore;
  const visibleSeriesCount = useMemo(() => shelfItems.filter((item) => item.kind === 'series').length, [shelfItems]);
  const selectedBooks = useMemo(() => visibleBooks.filter((book) => selectedBookIds.has(book.id)), [selectedBookIds, visibleBooks]);
  const visibleBookIds = useMemo(() => new Set(visibleBooks.map((book) => book.id)), [visibleBooks]);
  const isBulkBusy = bulkOperation !== null || pendingBookActionIds.size > 0;
  const isShelfReplacing = isLoading || isRefreshing || loadedShelfKey !== shelfKey || Boolean(loadError);

  useEffect(() => {
    setSelectedBookIds((currentIds) => {
      const nextIds = new Set([...currentIds].filter((bookId) => visibleBookIds.has(bookId)));
      return nextIds.size === currentIds.size ? currentIds : nextIds;
    });
  }, [visibleBookIds]);

  useEffect(() => {
    if (!expandedListSeriesKey || shelfItems.some((item) => item.kind === 'series' && item.key === expandedListSeriesKey)) return;
    setExpandedListSeriesKey(null);
  }, [expandedListSeriesKey, shelfItems]);

  const loadNextPage = useCallback(() => {
    if (!hasMoreShelfItems || isLoading || isRefreshing || refreshError || isLoadingMore || isShelfPaginationStale) return;
    const requestGate = requestGateRef.current;
    const request = requestGate.begin('append');
    if (!request) return;
    setIsLoadingMore(true);
    setPageError('');
    void getBookList({ kind: searchableKind, q: query, signal: request.signal, sort, shelf, page: page + 1, pageSize: BOOK_PAGE_SIZE })
      .then((result) => {
        if (!requestGate.isCurrent(request.id)) return;
        // Offset pages can overlap after reading progress or sort order changes.
        // Deduplication alone would hide the book that moved into an earlier page.
        if (result.total !== total || result.books.some((book) => books.some((loaded) => loaded.id === book.id))) {
          invalidateShelf();
          return;
        }
        setBooks((current) => [...current, ...result.books.filter((book) => !current.some((item) => item.id === book.id))]);
        setPage(result.page);
        loadedWindowRef.current = { key: shelfFilterKey, pages: result.page };
        setTotal(result.total);
        setHasMore(result.hasMore);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error) && requestGate.isCurrent(request.id)) {
          setPageError(error instanceof Error ? error.message : '加载下一页失败');
        }
      })
      .finally(() => {
        if (requestGate.isCurrent(request.id)) setIsLoadingMore(false);
        requestGate.complete(request.id, 'append');
      });
  }, [books, hasMoreShelfItems, isLoading, isRefreshing, refreshError, isLoadingMore, isShelfPaginationStale, searchableKind, query, sort, shelf, shelfFilterKey, page, total, invalidateShelf]);

  useEffect(() => {
    if (!hasMoreShelfItems || isLoading || isLoadingMore || pageError) return undefined;
    const sentinel = shelfLoadSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNextPage();
    }, { rootMargin: '800px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreShelfItems, isLoading, isLoadingMore, pageError, loadNextPage]);

  useEffect(() => {
    if (navigationSnapshot && page < navigationSnapshot.pages && hasMore && !isLoading && !isLoadingMore && !pageError) loadNextPage();
  }, [navigationSnapshot, page, hasMore, isLoading, isLoadingMore, pageError, loadNextPage]);

  const updateBookInState = (updatedBook: Book) => {
    setBooks((currentBooks) => currentBooks.map((book) => (book.id === updatedBook.id ? updatedBook : book)));
  };

  const toggleBookSelection = (bookId: string) => {
    if ((isShelfReplacing && !isRefreshing) || isBulkBusy) return;
    deferShelfRefreshForAction();
    setBulkMessage('');
    setSelectedBookIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (nextIds.has(bookId)) {
        nextIds.delete(bookId);
      } else {
        nextIds.add(bookId);
      }
      return nextIds;
    });
  };

  const selectAllVisibleBooks = () => {
    if (isShelfReplacing || isBulkBusy) return;
    setBulkMessage('');
    setSelectedBookIds(new Set(visibleBooks.map((book) => book.id)));
  };

  const clearSelection = () => {
    if (isShelfReplacing || isBulkBusy) return;
    setBulkMessage('');
    setSelectedBookIds(new Set());
  };

  const requestSingleDelete = (book: Book) => {
    if ((isShelfReplacing && !isRefreshing) || bulkOperation !== null || pendingBookActionsRef.current.has(book.id)) return;
    deferShelfRefreshForAction();
    setDeleteError('');
    setBookPendingDelete(book);
  };

  const toggleBookDisliked = (book: Book) => {
    if ((isShelfReplacing && !isRefreshing) || bulkOperation !== null || pendingBookActionsRef.current.has(book.id)) return;
    deferShelfRefreshForAction();
    const mutation = beginMutation();
    // Guard synchronously: a second tap can arrive before React disables the button.
    pendingBookActionsRef.current.set(book.id, mutation.controller);
    setPendingBookActionIds(new Set(pendingBookActionsRef.current.keys()));
    setBulkMessage('');
    void setBookDisliked(book.id, !book.disliked, mutation.controller.signal)
      .then((updatedBook) => {
        if (!isCurrentMutation(mutation)) return;
        updateBookInState(updatedBook);
        invalidateShelf();
        setBulkMessage(updatedBook.disliked ? `已将《${updatedBook.title}》移入“不喜欢”。` : `已将《${updatedBook.title}》恢复到书架。`);
      })
      .catch((error: unknown) => {
        if (isCurrentMutation(mutation) && !isAbortError(error)) setBulkMessage(error instanceof Error ? error.message : '操作失败');
      })
      .finally(() => {
        finishMutation(mutation);
        // A previous filter/account's response must not unlock a newer request.
        if (pendingBookActionsRef.current.get(book.id) !== mutation.controller) return;
        pendingBookActionsRef.current.delete(book.id);
        setPendingBookActionIds(new Set(pendingBookActionsRef.current.keys()));
      });
  };

  const confirmSingleDelete = async () => {
    if (!bookPendingDelete || isDeleting || isShelfReplacing) return;

    const mutation = beginMutation();
    setIsDeleting(true);
    setDeleteError('');
    try {
      await deleteBook(bookPendingDelete.id, mutation.controller.signal);
      if (!isCurrentMutation(mutation)) return;
      setBooks((currentBooks) => currentBooks.filter((book) => book.id !== bookPendingDelete.id));
      setSelectedBookIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(bookPendingDelete.id);
        return nextIds;
      });
      setBookPendingDelete(null);
      invalidateShelf();
    } catch (error: unknown) {
      if (isCurrentMutation(mutation) && !isAbortError(error)) setDeleteError(error instanceof Error ? error.message : '删除失败');
    } finally {
      finishMutation(mutation);
      if (isCurrentMutation(mutation)) setIsDeleting(false);
    }
  };

  const confirmBulkDelete = async () => {
    if (selectedBooks.length === 0 || isBulkBusy || isShelfReplacing) return;

    const targetBooks = [...selectedBooks];
    const mutation = beginMutation();
    setBulkOperation('delete');
    setBulkDeleteError('');
    const results = await Promise.allSettled(targetBooks.map((book) => deleteBook(book.id, mutation.controller.signal)));
    if (!isCurrentMutation(mutation)) {
      finishMutation(mutation);
      return;
    }
    const deletedIds = new Set(targetBooks.flatMap((book, index) => (results[index]?.status === 'fulfilled' ? [book.id] : [])));
    const failedIds = new Set(targetBooks.filter((book) => !deletedIds.has(book.id)).map((book) => book.id));
    setBooks((currentBooks) => currentBooks.filter((book) => !deletedIds.has(book.id)));
    setTotal((current) => Math.max(0, current - deletedIds.size));
    setSelectedBookIds(failedIds);
    setBulkOperation(null);
    if (deletedIds.size > 0) invalidateShelf();

    if (failedIds.size === 0) {
      setIsBulkDeleteDialogOpen(false);
      setBulkMessage(`已删除 ${deletedIds.size} 本，累计阅读时长记录已保留。`);
    } else {
      setBulkDeleteError(`已删除 ${deletedIds.size} 本，${failedIds.size} 本删除失败，可再次重试。`);
    }
    finishMutation(mutation);
  };

  const runBulkOperation = async (operation: BulkOperation, shareAllowsDownload = false) => {
    if (selectedBooks.length === 0 || isBulkBusy || isShelfReplacing) {
      return;
    }

    const targetBooks = getBulkOperationTargets(selectedBooks, operation);
    if (targetBooks.length === 0) {
      setBulkMessage(getNoTargetMessage(operation));
      return;
    }

    setBulkOperation(operation);
    setBulkMessage('');
    if (operation === 'share') setBulkShareError('');
    const mutation = beginMutation();
    const results = await Promise.allSettled(targetBooks.map((book) => runBookOperation(book, operation, shareAllowsDownload, mutation.controller.signal)));
    if (!isCurrentMutation(mutation)) {
      finishMutation(mutation);
      return;
    }
    const updatedBooks = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    updatedBooks.forEach(updateBookInState);
    if (updatedBooks.length > 0) invalidateShelf();
    const failedIds = new Set(targetBooks.flatMap((book, index) => results[index]?.status === 'rejected' ? [book.id] : []));
    const failedCount = failedIds.size;
    setBulkOperation(null);
    const message = failedCount > 0 ? `已处理 ${updatedBooks.length} 本，${failedCount} 本失败；失败项已保留选择，可重试。` : getSuccessMessage(operation, updatedBooks.length);
    setBulkMessage(message);
    setSelectedBookIds(failedIds);
    if (operation === 'share') {
      if (failedCount > 0) setBulkShareError(message);
      else setIsBulkShareDialogOpen(false);
    }
    finishMutation(mutation);
  };

  const saveBulkSeries = async ({ assignments, seriesKind, seriesTitle }: BulkSeriesSaveInput) => {
    if (assignments.length === 0 || isBulkBusy || isShelfReplacing) return;

    setBulkOperation('series');
    setBulkMessage('');
    const mutation = beginMutation();
    const results = await Promise.allSettled(assignments.map(({ book, seriesOrder }) => updateBook(book.id, {
      seriesKind,
      seriesOrder,
      seriesTitle,
    }, mutation.controller.signal)));
    if (!isCurrentMutation(mutation)) {
      finishMutation(mutation);
      return;
    }
    const updatedBooks = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const updatedById = new Map(updatedBooks.map((book) => [book.id, book]));
    const failedIds = new Set(assignments.flatMap(({ book }, index) => results[index]?.status === 'rejected' ? [book.id] : []));
    setBooks((currentBooks) => currentBooks.map((book) => updatedById.get(book.id) ?? book));
    if (updatedBooks.length > 0) invalidateShelf();
    setSelectedBookIds(failedIds);
    setBulkOperation(null);

    if (failedIds.size > 0) {
      finishMutation(mutation);
      throw new Error(`已保存 ${updatedBooks.length} 本，${failedIds.size} 本失败；失败项已保留选择，可重试。`);
    }

    setBulkMessage(seriesTitle ? `已将 ${updatedBooks.length} 本收纳到《${seriesTitle}》系列。` : `已将 ${updatedBooks.length} 本移出系列。`);
    finishMutation(mutation);
  };

  return (
    <Panel className="library-page" data-navigation-pages={page} data-navigation-has-more={hasMore} data-navigation-loading={isLoading || isRefreshing || isLoadingMore || (page < (navigationSnapshot?.pages ?? 1) && hasMore && !pageError && !refreshError)}>
      <div className="library-page-header mb-4 flex flex-wrap items-center justify-between gap-3 lg:mb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="app-page-title whitespace-nowrap font-display text-3xl font-semibold text-stone-950 sm:text-4xl dark:text-night-ink">书架</h1>
          {!isLoading && !loadError && (
            <span className="shrink-0 whitespace-nowrap font-display text-sm tabular-nums text-ink/45 dark:text-stone-500">{total} 本</span>
          )}
        </div>
        <div className="library-shelf-summary flex flex-wrap items-center gap-3">
          <span className="text-xs text-stone-500 dark:text-stone-400">
            {isLoading ? '正在加载书架' : loadError ? '书架暂未加载' : (
              <>
                已加载 <strong className="font-semibold tabular-nums text-stone-900 dark:text-night-ink">{visibleBooks.length}</strong> / {total} 本
                {!isBulkMode && visibleSeriesCount > 0 && (
                  <> · <strong className="font-semibold tabular-nums text-stone-900 dark:text-night-ink">{visibleSeriesCount}</strong> 个系列</>
                )}
              </>
            )}
          </span>
          <Button
            className="min-h-11 px-3 text-xs lg:min-h-8"
            disabled={isShelfReplacing || isBulkBusy}
            onClick={() => {
              setBulkMessage('');
              setIsBulkMode((current) => !current);
              setSelectedBookIds(new Set());
            }}
            variant={isBulkMode ? 'primary' : 'secondary'}
          >
            {isBulkMode ? '退出管理' : '批量管理'}
          </Button>
        </div>
      </div>
      <LibraryFilters
        activeKind={activeKind}
        onKindChange={(nextKind) => updateFilters({ kind: nextKind })}
        onSortChange={(nextSort) => updateFilters({ sort: nextSort })}
        sort={sort}
        view={view}
        onViewChange={setView}
      />
      {isBulkMode && (
        <div className={cn('mt-3 border-b pb-4', HAIRLINE)}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-stone-600 dark:text-night-soft">
              已选择 <strong className="font-semibold tabular-nums text-stone-950 dark:text-night-ink">{selectedBooks.length}</strong> 本
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="min-h-9 px-3 text-xs" disabled={isShelfReplacing || visibleBooks.length === 0 || selectedBooks.length === visibleBooks.length || isBulkBusy} onClick={selectAllVisibleBooks} variant="secondary">
                选择已加载
              </Button>
              <Button className="min-h-9 px-3 text-xs" disabled={isShelfReplacing || selectedBooks.length === 0 || isBulkBusy} icon={<X className="h-3.5 w-3.5" />} onClick={clearSelection} variant="secondary">
                清空
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <BulkActionButton busyOperation={bulkOperation} disabled={isShelfReplacing || selectedBooks.length === 0} icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="标记已读" operation="read" onRun={runBulkOperation} />
            <BulkActionButton busyOperation={bulkOperation} disabled={isShelfReplacing || selectedBooks.length === 0} icon={<Circle className="h-3.5 w-3.5" />} label="标记未读" operation="unread" onRun={runBulkOperation} />
            <BulkActionButton busyOperation={bulkOperation} disabled={isShelfReplacing || selectedBooks.length === 0} icon={<Heart className="h-3.5 w-3.5" />} label="加入收藏" operation="favorite" onRun={runBulkOperation} />
            <BulkActionButton busyOperation={bulkOperation} disabled={isShelfReplacing || selectedBooks.length === 0} icon={<Heart className="h-3.5 w-3.5" />} label="取消收藏" operation="unfavorite" onRun={runBulkOperation} />
            <Button
              className="min-h-9 px-3 text-xs"
              disabled={isShelfReplacing || selectedBooks.length === 0 || isBulkBusy}
              icon={<Layers3 className="h-3.5 w-3.5" />}
              onClick={() => setIsBulkSeriesDialogOpen(true)}
              variant="secondary"
            >
              设置系列
            </Button>
            {activeKind === 'disliked' ? (
              <BulkActionButton busyOperation={bulkOperation} disabled={isShelfReplacing || selectedBooks.length === 0} icon={<Undo2 className="h-3.5 w-3.5" />} label="恢复显示" operation="restore" onRun={runBulkOperation} />
            ) : (
              <BulkActionButton busyOperation={bulkOperation} disabled={isShelfReplacing || selectedBooks.length === 0} icon={<ThumbsDown className="h-3.5 w-3.5" />} label="不喜欢" operation="dislike" onRun={runBulkOperation} />
            )}
            <BulkActionButton
              busyOperation={bulkOperation}
              disabled={isShelfReplacing || selectedBooks.length === 0}
              icon={<Share2 className="h-3.5 w-3.5" />}
              label="申请共享"
              operation="share"
              onRun={() => {
                setBulkShareAllowsDownload(false);
                setBulkShareError('');
                setIsBulkShareDialogOpen(true);
              }}
            />
            <BulkActionButton busyOperation={bulkOperation} disabled={isShelfReplacing || selectedBooks.length === 0} icon={<Undo2 className="h-3.5 w-3.5" />} label="撤回共享" operation="unshare" onRun={runBulkOperation} />
            <Button
              className="min-h-9 px-3 text-xs"
              disabled={isShelfReplacing || selectedBooks.length === 0 || isBulkBusy}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => {
                setBulkDeleteError('');
                setIsBulkDeleteDialogOpen(true);
              }}
              variant="danger"
            >
              删除所选
            </Button>
          </div>
          {bulkMessage && <p role="status" className="mt-3 whitespace-pre-wrap text-sm [overflow-wrap:anywhere] text-accent dark:text-peach">{bulkMessage}</p>}
        </div>
      )}
      {!isBulkMode && bulkMessage && <p role="status" className="mt-3 whitespace-pre-wrap text-sm [overflow-wrap:anywhere] text-accent dark:text-peach">{bulkMessage}</p>}
      <BulkShareConfirmDialog
        allowsDownload={bulkShareAllowsDownload}
        errorMessage={bulkShareError}
        count={getBulkOperationTargets(selectedBooks, 'share').length}
        isOpen={isBulkShareDialogOpen}
        isPending={isShelfReplacing || isBulkBusy}
        onAllowsDownloadChange={setBulkShareAllowsDownload}
        onCancel={() => setIsBulkShareDialogOpen(false)}
        onConfirm={() => void runBulkOperation('share', bulkShareAllowsDownload)}
      />
      <BulkSeriesDialog
        books={selectedBooks}
        isOpen={isBulkSeriesDialogOpen}
        isPending={isShelfReplacing || isBulkBusy}
        onCancel={() => setIsBulkSeriesDialogOpen(false)}
        onSave={saveBulkSeries}
      />
      <BulkDeleteConfirmDialog
        count={selectedBooks.length}
        errorMessage={bulkDeleteError}
        isDeleting={bulkOperation === 'delete'}
        isOpen={isBulkDeleteDialogOpen}
        onCancel={() => {
          if (bulkOperation !== 'delete') setIsBulkDeleteDialogOpen(false);
        }}
        onConfirm={() => void confirmBulkDelete()}
      />
      <DeleteBookDialog
        bookTitle={bookPendingDelete?.title ?? ''}
        errorMessage={deleteError}
        isDeleting={isDeleting}
        isOpen={bookPendingDelete !== null}
        onCancel={() => {
          if (!isDeleting) setBookPendingDelete(null);
        }}
        onConfirm={() => void confirmSingleDelete()}
      />
      {loadError ? (
        <div className="mt-6 lg:mt-4">
          <EmptyState
            action={<Button onClick={() => setReloadKey((currentKey) => currentKey + 1)}>重试</Button>}
            description={loadError}
            title="书架加载失败"
          />
        </div>
      ) : isLoading ? (
        <div className={view === 'grid' ? 'mt-6 lg:mt-4' : 'mt-3'}>
          <BookShelfSkeleton view={view} />
        </div>
      ) : visibleBooks.length === 0 ? (
        <div className="mt-6 lg:mt-4">
          <EmptyState
            title={query ? '没有找到相关图书' : activeKind !== 'all' ? '这个分类暂无图书' : '书架还是空的'}
            description={query ? '试试其他书名或作者，或清除筛选条件。' : activeKind !== 'all' ? '可以切换到全部，查看书架中的其他图书。' : '添加第一本书，就可以在这里整理和继续阅读。'}
            action={query || activeKind !== 'all'
              ? <Button onClick={() => updateFilters({ kind: 'all', query: '' })}>查看全部图书</Button>
              : <LinkButton to={ROUTES.upload}>添加图书</LinkButton>}
          />
        </div>
      ) : view === 'grid' ? (
        <div className="library-grid-section mt-6 lg:mt-4">
          <BookGrid books={displayedBooks} groupSeries={!isBulkMode} isBookActionPending={(bookId) => pendingBookActionIds.has(bookId)} isBookSelected={(bookId) => selectedBookIds.has(bookId)} onDeleteBook={requestSingleDelete} onSelectBook={toggleBookSelection} onToggleDisliked={toggleBookDisliked} selectionMode={isBulkMode} />
        </div>
      ) : (
        <div className="mt-3">
          {displayedShelfItems.map((item) => item.kind === 'series' ? (
            <BookSeriesListGroup
              isBookActionPending={(bookId) => pendingBookActionIds.has(bookId)}
              isExpanded={activeListSeriesKey === item.key}
              key={`series:${item.key}`}
              onDeleteBook={requestSingleDelete}
              onToggleDisliked={toggleBookDisliked}
              onToggle={() => setExpandedListSeriesKey(activeListSeriesKey === item.key ? null : item.key)}
              series={item}
            />
          ) : (
            <BookListItem book={item.book} isActionPending={pendingBookActionIds.has(item.book.id)} isSelected={selectedBookIds.has(item.book.id)} key={item.book.id} onRequestDelete={requestSingleDelete} onSelect={toggleBookSelection} onToggleDisliked={toggleBookDisliked} readerPath={getReaderRouteForBook(item.book)} selectionMode={isBulkMode} />
          ))}
        </div>
      )}
      {!isLoading && !loadError && (books.length > 0 || isRefreshing || refreshError) && <ShelfListFooter
        hasMore={hasMoreShelfItems}
        heldMessage={hasMoreShelfItems && isShelfPaginationStale && holdsShelfRefresh ? '完成当前操作或清空选择后，将更新书架并继续加载。' : undefined}
        isLoadingMore={isLoadingMore}
        isRefreshing={isRefreshing}
        onLoadMore={loadNextPage}
        onRetryRefresh={() => setReloadKey((key) => key + 1)}
        pageError={isShelfPaginationStale ? '' : pageError}
        refreshError={refreshError}
        sentinelRef={shelfLoadSentinelRef}
      />}
    </Panel>
  );
}

type BulkOperation = 'dislike' | 'favorite' | 'read' | 'restore' | 'share' | 'unfavorite' | 'unread' | 'unshare';

function getBulkOperationTargets(books: Book[], operation: BulkOperation): Book[] {
  if (operation === 'share') {
    return books.filter((book) => book.isOwned !== false && (book.publicStatus === 'private' || book.publicStatus === 'rejected' || !book.publicStatus));
  }

  if (operation === 'unshare') {
    return books.filter((book) => book.isOwned !== false && (book.publicStatus === 'pending' || book.publicStatus === 'public'));
  }

  return books;
}

function runBookOperation(book: Book, operation: BulkOperation, shareAllowsDownload = false, signal?: AbortSignal): Promise<Book> {
  if (operation === 'read') {
    return setBookReadingCompletion(book.id, true, signal);
  }

  if (operation === 'unread') {
    return setBookReadingCompletion(book.id, false, signal);
  }

  if (operation === 'favorite') {
    return setBookFavorite(book.id, true, signal);
  }

  if (operation === 'unfavorite') {
    return setBookFavorite(book.id, false, signal);
  }

  if (operation === 'dislike') {
    return setBookDisliked(book.id, true, signal);
  }

  if (operation === 'restore') {
    return setBookDisliked(book.id, false, signal);
  }

  if (operation === 'share') {
    return requestBookPublicShare(book.id, { publicDownloadAllowed: shareAllowsDownload }, signal);
  }

  return cancelBookPublicShare(book.id, signal);
}

function BulkDeleteConfirmDialog({
  count,
  errorMessage,
  isDeleting,
  isOpen,
  onCancel,
  onConfirm,
}: {
  count: number;
  errorMessage: string;
  isDeleting: boolean;
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, onCancel, !isDeleting);
  if (!isOpen) return null;

  return (
    <ViewportDialogPortal className="z-[100] grid place-items-center bg-stone-950/45 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="bulk-delete-title" aria-modal="true" className="book-management-dialog book-action-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-md overflow-y-auto rounded-[28px] border border-stone-200 bg-shell p-6 shadow-2xl reader-scrollbar dark:border-white/10 dark:bg-night-surface" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="book-dialog-symbol grid h-12 w-12 place-items-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/30 dark:text-red-300">
          <Trash2 className="h-5 w-5" />
        </div>
        <h2 className="mt-5 font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="bulk-delete-title">删除所选图书？</h2>
        <p className="mt-3 text-sm leading-7 text-stone-500 dark:text-night-soft">
          将从书架移除 {count} 本书，并删除服务器上的原文件、封面和解析缓存。累计阅读时长会永久保留在账号统计中；图书文件删除后不可恢复。
        </p>
        {errorMessage && <p role="alert" className="mt-4 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-300">{errorMessage}</p>}
        <div className="book-action-footer mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button disabled={isDeleting} onClick={onCancel} variant="secondary">取消</Button>
          <Button disabled={isDeleting || count === 0} icon={<Trash2 className="h-4 w-4" />} onClick={onConfirm} variant="danger">
            {isDeleting ? '删除中...' : `确认删除 ${count} 本`}
          </Button>
        </div>
      </div>
    </ViewportDialogPortal>
  );
}

function BulkShareConfirmDialog({
  allowsDownload,
  errorMessage,
  count,
  isOpen,
  isPending = false,
  onAllowsDownloadChange,
  onCancel,
  onConfirm,
}: {
  allowsDownload: boolean;
  errorMessage: string;
  count: number;
  isOpen: boolean;
  isPending?: boolean;
  onAllowsDownloadChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, onCancel, !isPending);
  if (!isOpen) return null;
  return (
    <ViewportDialogPortal className="z-[100] grid place-items-center bg-stone-950/40 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="bulk-share-title" aria-modal="true" className="book-management-dialog book-action-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-md overflow-y-auto rounded-[28px] border border-stone-200 bg-shell p-6 shadow-2xl reader-scrollbar dark:border-white/10 dark:bg-night-surface" ref={dialogRef} role="dialog" tabIndex={-1}>
        <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="bulk-share-title">确认提交共享</h2>
        <p className="mt-3 text-sm leading-7 text-stone-500 dark:text-night-soft">
          将把 {count} 本书提交给管理员审核。默认仅允许站内在线阅读，不开放原文件下载。
        </p>
        <label className="mt-5 flex items-start gap-3 rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm dark:border-white/10 dark:bg-white/[0.04]">
          <input checked={allowsDownload} className="mt-1 h-4 w-4 shrink-0 rounded text-accent focus:ring-accent" disabled={isPending} onChange={(event) => onAllowsDownloadChange(event.target.checked)} type="checkbox" />
          <span>
            <span className="block font-medium text-stone-900 dark:text-night-ink">同时允许下载原文件</span>
            <span className="mt-1 block leading-6 text-stone-500 dark:text-stone-400">只有确认拥有分享权限时再开启。</span>
          </span>
        </label>
        {errorMessage && <p role="alert" className="mt-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-red-600 dark:text-red-300">{errorMessage}</p>}
        <div className="book-action-footer mt-6 flex justify-end gap-3">
          <Button disabled={isPending} onClick={onCancel} variant="secondary">取消</Button>
          <Button disabled={isPending || count === 0} icon={<Share2 className="h-4 w-4" />} onClick={onConfirm}>{isPending ? '提交中…' : '提交审核'}</Button>
        </div>
      </div>
    </ViewportDialogPortal>
  );
}

function getSuccessMessage(operation: BulkOperation, count: number): string {
  const actionLabel: Record<BulkOperation, string> = {
    favorite: '已加入收藏',
    dislike: '已移入不喜欢',
    read: '已标记已读',
    share: '已提交共享审核',
    unfavorite: '已取消收藏',
    restore: '已恢复到书架',
    unread: '已标记未读',
    unshare: '已撤回共享',
  };
  return `${actionLabel[operation]}：${count} 本。`;
}

function getNoTargetMessage(operation: BulkOperation): string {
  if (operation === 'share') {
    return '选中的书没有可申请共享的项目。';
  }

  if (operation === 'unshare') {
    return '选中的书没有可撤回共享的项目。';
  }

  return '没有可处理的书。';
}

function BulkActionButton({ busyOperation, disabled, icon, label, onRun, operation }: { busyOperation: BulkOperation | string | null; disabled: boolean; icon: ReactNode; label: string; onRun: (operation: BulkOperation) => void | Promise<void>; operation: BulkOperation }) {
  const isBusy = busyOperation === operation;
  return (
    <Button className="min-h-9 px-3 text-xs" disabled={disabled || busyOperation !== null} icon={icon} onClick={() => void onRun(operation)} variant="secondary">
      {isBusy ? '处理中...' : label}
    </Button>
  );
}
