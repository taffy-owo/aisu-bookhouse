import { useReaderDownload } from '../hooks/useReaderDownload';
import { ImageOff, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getNovelReaderPath } from '../../../config/routes';
import { useReaderCatalogRefresh } from '../hooks/useReaderCatalogRefresh';
import { useReaderEditionSwitch } from '../hooks/useReaderEditionSwitch';
import { acknowledgeReaderStartup, stageReaderStartup, takeReaderStartup } from '../services/readerStartupHandoff';
import type { ReaderResourceLoadState } from '../types/novelReaderState';
import { useSession } from '../../../app/SessionContext';
import { getAccountScope } from '../../../shared/api';
import { getBrowserReaderAvailability } from '../../books';
import type { Book } from '../../books';
import { useAuthenticatedImageResource } from '../../../shared/hooks/useAuthenticatedImageUrl';
import { cn } from '../../../shared/utils/cn';
import { MangaPagePanel } from '../components/MangaPagePanel';
import { MangaPageNavigator } from '../components/MangaPageNavigator';
import { ProgressSyncIndicator } from '../components/ProgressSyncIndicator';
import { ReaderMarksPanel } from '../components/ReaderMarksPanel';
import { ReaderStartupState } from '../components/ReaderStartupState';
import { ReaderTopBar } from '../components/ReaderTopBar';
import { UnsupportedReaderState } from '../components/UnsupportedReaderState';
import { useReaderControls } from '../hooks/useReaderControls';
import { useReaderMarksRefresh } from '../hooks/useReaderMarksRefresh';
import { useReaderKeyboardShortcuts } from '../hooks/useReaderKeyboardShortcuts';
import { isReaderInteractiveTarget, useReaderTouchGestures } from '../hooks/useReaderTouchGestures';
import { useMangaStageClicks } from '../hooks/useMangaStageClicks';
import { useMangaImageLayout } from '../hooks/useMangaImageLayout';
import { useReadingActivityTracker } from '../hooks/useReadingActivityTracker';
import { useReadingProgress } from '../hooks/useReadingProgress';
import { createReaderMark, deleteReaderMark, getReaderMarks, relocateReaderMark } from '../services/readerMarkService';
import { createReaderMarksController } from '../services/readerMarksController';
import { applyReaderBrowserChromeTheme } from '../services/readerBrowserChrome';
import { getPendingReadingProgress, queueReadingProgressSync } from '../services/readingProgressSync';
import { getMediaProgressPercent, isMediaPageVisible, isMediaProgressBoundToResource, resolveInitialMediaProgress, shouldSaveVisibleMediaProgress } from '../services/mediaReadingProgress';
import { getReaderStartup } from '../services/readerService';
import { createReadingProgressTimestamp } from '../services/progressTimestamp';
import { getReaderStartupError } from '../services/readerStartupError';
import type { ReaderMark, ReaderMarkCreateInput, ReadingProgress } from '../types/reader';
import type { MangaPageFitMode } from '../utils/mangaPageLayout';
import { resolveReaderMarkTarget } from '../utils/readerMarkTarget';

export function MangaReaderPage() {
  const { session } = useSession();
  const { bookId = '' } = useParams();
  const { state: navigationState } = useLocation();
  const startupNavigationStateRef = useRef(navigationState);
  useLayoutEffect(() => { startupNavigationStateRef.current = navigationState; }, [navigationState]);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [book, setBook] = useState<Book | null>(null);
  const [resourceState, setResourceState] = useState<ReaderResourceLoadState>({ bookId: '', isLoaded: false, resource: null });
  const readerResource = resourceState.bookId === bookId ? resourceState.resource : null;
  const pendingResource = resourceState.bookId === bookId ? resourceState.pendingResource : undefined;
  const [bookLoadStatus, setBookLoadStatus] = useState<'loading' | 'loaded' | 'missing' | 'unavailable'>('loading');
  const [startupErrorMessage, setStartupErrorMessage] = useState<string | undefined>();
  const [resourceLoadStatus, setResourceLoadStatus] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [startupRetryKey, setStartupRetryKey] = useState(0);
  const download = useReaderDownload(bookId);
  const [isPagePanelOpen, setIsPagePanelOpen] = useState(false);
  const [isMarksOpen, setIsMarksOpen] = useState(false);
  const [imageScale, setImageScale] = useState(1);
  const stageRef = useRef<HTMLElement | null>(null);
  const controls = useReaderControls(true, isPagePanelOpen || isMarksOpen);
  const readingProgress = useReadingProgress(null);
  const mediaAccountScopeRef = useRef<string | null>(null);
  const { resetProgress, updateProgress } = readingProgress;
  const marksController = useMemo(() => {
    void session?.id;
    return createReaderMarksController(bookId, {
      load: getReaderMarks,
      create: createReaderMark,
      relocate: relocateReaderMark,
      remove: deleteReaderMark,
    }, getAccountScope);
  }, [bookId, session?.id]);
  const marksState = useSyncExternalStore(marksController.subscribe, marksController.getSnapshot);
  useReaderMarksRefresh(marksController, isMarksOpen && book?.id === bookId);
  useEffect(() => () => marksController.reset(), [marksController]);

  useEffect(() => applyReaderBrowserChromeTheme('dark'), []);
  const contentCheck = useReaderCatalogRefresh(bookId, book?.publicationStatus, resourceLoadStatus === 'loaded', isPagePanelOpen, setResourceState);
  const reloadEdition = useCallback(() => setStartupRetryKey((key) => key + 1), []);
  const editionSwitch = useReaderEditionSwitch(bookId, pendingResource, reloadEdition);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const accountScope = getAccountScope();
    mediaAccountScopeRef.current = null;
    setBook(null);
    setResourceState({ bookId, isLoaded: false, resource: null });
    setBookLoadStatus('loading');
    setStartupErrorMessage(undefined);
    setResourceLoadStatus('loading');
    marksController.reset();
    resetProgress();
    // A save can clear the outbox while startup still holds an older server
    // snapshot. Retain the queued position until that response is reconciled.
    const pendingAtStartup = getPendingReadingProgress(bookId);
    const handoff = takeReaderStartup(bookId);
    void (handoff ? Promise.resolve(handoff) : getReaderStartup(bookId, undefined, controller.signal)).then((startup) => {
      if (!isMounted || controller.signal.aborted || getAccountScope() !== accountScope) return;
      if (startup.resource.readerType !== 'comic' && startup.resource.readerType !== 'image') {
        stageReaderStartup(bookId, startup, getPendingReadingProgress(bookId) ?? pendingAtStartup);
        navigate(getNovelReaderPath(bookId), { replace: true, state: startupNavigationStateRef.current });
        return;
      }
      acknowledgeReaderStartup(bookId, startup);
      mediaAccountScopeRef.current = accountScope;
      setBook(startup.book);
      setResourceState({ bookId, isLoaded: true, resource: startup.resource });
      setBookLoadStatus('loaded');
      setResourceLoadStatus('loaded');
      marksController.seed(startup.marks);
      updateProgress(resolveInitialMediaProgress(startup.resource, startup.progress, getPendingReadingProgress(bookId) ?? pendingAtStartup));
    }).catch((error: unknown) => {
      if (isMounted && !controller.signal.aborted && getAccountScope() === accountScope) {
        const startupError = getReaderStartupError(error);
        setBookLoadStatus(startupError.status);
        setStartupErrorMessage(startupError.message);
        setResourceLoadStatus('unavailable');
      }
    });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [bookId, marksController, navigate, resetProgress, session?.id, startupRetryKey, updateProgress]);

  const pages = useMemo(() => readerResource && 'pages' in readerResource ? readerResource.pages.filter((page) => page.imageUrl) : [], [readerResource]);
  const pageCount = Math.max(pages.length, 1);
  const requestedPageIndex = parseRequestedPageIndex(searchParams);
  const progressPercent = readingProgress.progress?.progressPercent ?? book?.progressPercent ?? 0;
  const currentImageIndex = Math.min(pageCount, Math.max(1, requestedPageIndex ?? readingProgress.progress?.imageIndex ?? Math.max(1, Math.round((progressPercent / 100) * pageCount))));
  const currentPage = pages[currentImageIndex - 1] ?? pages[0];
  // Keep the next two pages mounted (invisible): their resource hooks hold the
  // downloaded blobs, so advancing shows them instantly. Pages that leave this
  // window unmount and release their object URLs — nothing enters the
  // long-lived blob cache, preserving the "large images stay per-mount" rule.
  const mountedPages = pages.slice(currentImageIndex - 1, currentImageIndex + 2);
  const displayedProgressPercent = Math.round(progressPercent);
  const activityScope = getAccountScope();
  const readingIdentity = JSON.stringify([activityScope, bookId, currentPage?.positionKey, currentImageIndex]);
  const { fitAreaRef, imageSize, fitMode: pageFitMode, captureZoomAnchor, onImageLoad } = useMangaImageLayout(stageRef, readingIdentity, imageScale);
  const [readableIdentity, setReadableIdentity] = useState<string | null>(null);
  const handleReadabilityChange = useCallback((visible: boolean) => {
    const readable = visible && mediaAccountScopeRef.current === activityScope && getAccountScope() === activityScope;
    setReadableIdentity((previous) => readable ? readingIdentity : previous === readingIdentity ? null : previous);
  }, [activityScope, readingIdentity]);
  const visiblePageRef = useRef<{ identity: string; initial: boolean } | null>(null);
  useLayoutEffect(() => { visiblePageRef.current = null; }, [bookId, session?.id, startupRetryKey]);
  const handleVisiblePage = useCallback(() => {
    if (!book || !currentPage || !readerResource || pendingResource || isPagePanelOpen || isMarksOpen || mediaAccountScopeRef.current !== getAccountScope()) return;
    const nextProgress: ReadingProgress = {
      bookId, imageIndex: currentImageIndex, positionKey: currentPage.positionKey,
      progressPercent: getMediaProgressPercent(currentImageIndex, pageCount), readerType: book.readerType,
      updatedAt: createReadingProgressTimestamp(readingProgress.progress?.updatedAt, bookId),
    };
    const pending = getPendingReadingProgress(bookId);
    const needsRebase = pending && !isMediaProgressBoundToResource(pending, readerResource);
    const identity = JSON.stringify([bookId, currentPage.positionKey, currentImageIndex]);
    const previous = visiblePageRef.current;
    const initial = !previous || (previous.initial && previous.identity === identity);
    visiblePageRef.current = { identity, initial };
    if (!shouldSaveVisibleMediaProgress(readingProgress.progress, nextProgress, initial)) {
      if (!needsRebase) return;
      nextProgress.progressPercent = readingProgress.progress?.progressPercent ?? nextProgress.progressPercent;
    }
    updateProgress(nextProgress);
    void queueReadingProgressSync(bookId, nextProgress);
  }, [book, bookId, currentImageIndex, currentPage, isMarksOpen, isPagePanelOpen, pageCount, pendingResource, readerResource, readingProgress.progress, updateProgress]);
  useReadingActivityTracker(Boolean(currentPage) && readableIdentity === readingIdentity && !isPagePanelOpen && !isMarksOpen, bookId);

  const handlePageSelect = useCallback(
    (pageIndex: number) => {
      if (!book || pendingResource) {
        return;
      }

      const nextImageIndex = Math.min(pageCount, Math.max(1, pageIndex));
      const nextSearchParams = new URLSearchParams(searchParams);

      nextSearchParams.set('page', String(nextImageIndex));
      setSearchParams(nextSearchParams, { replace: true, state: navigationState });
      if (nextImageIndex !== currentImageIndex) {
        setImageScale(1);
      }
      // The selected URL moves immediately; progress waits for the visible
      // image to decode, so a failed or prefetched page is never marked read.
    },
    [book, currentImageIndex, pageCount, pendingResource, navigationState, searchParams, setSearchParams],
  );

  const handlePageStep = useCallback(
    (deltaPage: number) => {
      handlePageSelect(currentImageIndex + deltaPage);
    },
    [currentImageIndex, handlePageSelect],
  );

  const handleZoomStep = useCallback((deltaScale: number) => {
    if (clampScale(imageScale + deltaScale) === imageScale) return;
    captureZoomAnchor();
    setImageScale((currentScale) => clampScale(currentScale + deltaScale));
  }, [captureZoomAnchor, imageScale]);

  const handleZoomReset = useCallback(() => {
    if (imageScale === 1) return;
    captureZoomAnchor();
    setImageScale(1);
  }, [captureZoomAnchor, imageScale]);

  useReaderKeyboardShortcuts({
    disabled: isPagePanelOpen || isMarksOpen,
    onArrowLeft: () => handlePageStep(-1),
    onArrowRight: () => handlePageStep(1),
    onZoomIn: () => handleZoomStep(0.25),
    onZoomOut: () => handleZoomStep(-0.25),
    onZoomReset: handleZoomReset,
  });

  const handleSwipeNext = useCallback(() => handlePageStep(1), [handlePageStep]);
  const handleSwipePrevious = useCallback(() => handlePageStep(-1), [handlePageStep]);

  // Keep tracking zoomed drags to suppress their compatibility clicks;
  // only fit-scale swipes navigate, while zoomed gestures pan the image.
  const { shouldIgnoreClick } = useReaderTouchGestures({
    enabled: pages.length > 0 && !isPagePanelOpen && !isMarksOpen,
    onSwipeLeft: imageScale <= 1 ? handleSwipeNext : undefined,
    onSwipeRight: imageScale <= 1 ? handleSwipePrevious : undefined,
    targetRef: stageRef,
  });

  const resolveMarkPosition = useCallback(
    (input: ReaderMarkCreateInput) => {
      if (pendingResource) throw new Error('阅读文件已更新，请先打开新版；备注草稿已保留。');
      if (input.readerType !== book?.readerType) throw new Error('草稿来自旧格式，请改存到当前位置。');
      if (input.positionKey) {
        const index = pages.findIndex((page) => page.positionKey === input.positionKey);
        if (index < 0) throw new Error('草稿所属图片页已更新，请改存到当前位置。');
        return { ...input, imageIndex: index + 1, pageNumber: index + 1, progressPercent: getMediaProgressPercent(index + 1, pageCount) };
      }
      return input;
    },
    [book?.readerType, pageCount, pages, pendingResource],
  );
  const handleCreateMark = useCallback(async (input: ReaderMarkCreateInput) => marksController.create(resolveMarkPosition(input)), [marksController, resolveMarkPosition]);
  const handleRelocateMark = useCallback(async (mark: ReaderMark, input: ReaderMarkCreateInput) => marksController.relocate(mark, resolveMarkPosition(input)), [marksController, resolveMarkPosition]);

  const handleDeleteMark = useCallback(
    async (mark: ReaderMark) => {
      return marksController.remove(mark);
    },
    [marksController],
  );

  const handleSelectMark = useCallback(
    (mark: ReaderMark) => {
      if (pendingResource) return false;
      const target = resolveReaderMarkTarget(mark, readerResource);
      if (target?.kind !== 'image') return false;
      handlePageSelect(target.index);
      return true;
    },
    [handlePageSelect, pendingResource, readerResource],
  );

  const handleStageAction = useCallback((action: 'previous' | 'next' | 'controls') => {
    if (action === 'previous') {
      handlePageStep(-1);
      return;
    }
    if (action === 'next') {
      handlePageStep(1);
      return;
    }
    controls.toggleControls();
  }, [controls, handlePageStep]);

  const stageClickIdentity = JSON.stringify([bookId, currentImageIndex, imageScale, pageFitMode, isPagePanelOpen, isMarksOpen]);
  const stageClicks = useMangaStageClicks(stageClickIdentity, handleStageAction, () => {
    setImageScale((currentScale) => (currentScale > 1 ? 1 : 1.75));
  });

  if (!book || book.id !== bookId) {
    return <ReaderStartupState bookId={bookId} dark message={startupErrorMessage} onRetry={bookLoadStatus === 'loading' ? undefined : () => setStartupRetryKey((key) => key + 1)} status={bookLoadStatus === 'missing' ? 'missing' : bookLoadStatus === 'unavailable' ? 'unavailable' : 'loading'} />;
  }
  if (resourceLoadStatus !== 'loaded') {
    return <ReaderStartupState bookId={bookId} dark message={startupErrorMessage} onRetry={resourceLoadStatus === 'unavailable' ? () => setStartupRetryKey((key) => key + 1) : undefined} status={resourceLoadStatus === 'unavailable' ? 'unavailable' : 'loading'} />;
  }

  const availability = getBrowserReaderAvailability(book, readerResource);

  if (!availability.canReadInBrowser) {
    return (
      <UnsupportedReaderState
        book={book}
        downloadError={download.error}
        isDownloadPreparing={download.isPreparing}
        isDownloadDisabled={!book.fileSize}
        message={availability.reason ?? '当前文件已保存在私有书库，可先下载原文件阅读；图片页解析完成后会开放在线阅读。'}
        onDownload={() => void download.run(book)}
        theme="dark"
      />
    );
  }

  const handleReaderStageClick = (event: MouseEvent<HTMLElement>) => {
    if (isPagePanelOpen || isMarksOpen || shouldIgnoreClick() || isReaderInteractiveTarget(event.target)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;

    if (clickX < rect.width * 0.42) {
      stageClicks.click('previous', event.detail);
      return;
    }

    if (clickX > rect.width * 0.58) {
      stageClicks.click('next', event.detail);
      return;
    }

    stageClicks.click('controls', event.detail);
  };
  const currentMarkInput: ReaderMarkCreateInput = {
    positionKey: currentPage?.positionKey,
    imageIndex: currentImageIndex,
    kind: 'bookmark',
    label: `第 ${currentImageIndex} 页`,
    pageNumber: currentImageIndex,
    progressPercent: displayedProgressPercent,
    readerType: book.readerType,
  };

  return (
    <main className="reader-viewport reader-theme-dark fixed inset-0 z-40 overflow-hidden bg-black text-[color:var(--reader-ink)]" onPointerDownCapture={stageClicks.cancel}>
      <div onClick={(event) => event.stopPropagation()}>
        <ReaderTopBar contentCheck={contentCheck} editionSwitch={editionSwitch} book={book} chapterTitle={`第 ${currentImageIndex} 页`} isDark isVisible={controls.isControlsVisible} onOpenToc={() => setIsPagePanelOpen(true)} />
      </div>
      <section className="reader-mobile-pan absolute inset-x-0 top-0 bottom-[calc(44px+env(safe-area-inset-bottom))] overflow-auto reader-scrollbar" style={{ scrollbarGutter: 'stable', overflowAnchor: 'none' }} onClick={handleReaderStageClick} ref={stageRef}>
        <div aria-hidden className="pointer-events-none invisible absolute inset-x-2 inset-y-2 sm:inset-x-4" ref={fitAreaRef} />
        <div
          className={cn(
            'flex min-h-full min-w-full w-max',
            imageScale > 1 || pageFitMode === 'width'
              ? 'items-start px-2 pb-[calc(6.5rem+env(safe-area-inset-bottom))] pt-[calc(4.75rem+env(safe-area-inset-top))] sm:px-4'
              : // At fit scale the wrapper is exactly one viewport tall, giving the
                // image a definite max-height: the whole page is always visible,
                // portrait phones fit by width and landscape by height.
                'h-full items-center px-2 py-2 sm:px-4',
          )}
        >
          {currentPage
            ? mountedPages.map((page, position) => (
                <MangaImagePage
                  imageScale={imageScale}
                  imageSize={imageSize}
                  imageUrl={page.imageUrl}
                  isActive={position === 0}
                  key={page.index}
                  onImageLoad={onImageLoad}
                  onVisible={handleVisiblePage}
                  onReadabilityChange={handleReadabilityChange}
                  isReadingAllowed={!isPagePanelOpen && !isMarksOpen}
                  onCheckUpdate={contentCheck.onRetry}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    captureZoomAnchor({ x: event.clientX, y: event.clientY });
                    stageClicks.doubleClick();
                  }}
                  title={`${book.title} 第 ${page.index} 页`}
                  fitMode={pageFitMode}
                />
              ))
            : null}
        </div>
      </section>
      <div onClick={(event) => event.stopPropagation()}>
        <MangaPageNavigator
          currentPageIndex={currentImageIndex}
          imageScale={imageScale}
          isVisible={controls.isControlsVisible}
          onNext={() => handlePageStep(1)}
          onOpenMarks={() => setIsMarksOpen(true)}
          onPrevious={() => handlePageStep(-1)}
          onZoomIn={() => handleZoomStep(0.25)}
          onZoomOut={() => handleZoomStep(-0.25)}
          onZoomReset={handleZoomReset}
          pageCount={pageCount}
          progressPercent={displayedProgressPercent}
        />
      </div>
      <footer className="manga-reading-status absolute inset-x-0 bottom-0 z-[35] flex h-[calc(44px+env(safe-area-inset-bottom))] items-start gap-4 bg-black px-4 pb-[env(safe-area-inset-bottom)] text-[11px] text-[color:var(--reader-muted)] sm:px-6">
        <div className="flex h-11 min-w-0 flex-1 items-center"><ProgressSyncIndicator bookId={bookId} inline actionable inverted /></div>
        {!controls.isControlsVisible && <span className="flex h-11 items-center tabular-nums">{currentImageIndex} / {pageCount}</span>}
        <span aria-label="阅读进度" className="flex h-11 items-center tabular-nums">{displayedProgressPercent}%</span>
      </footer>
      {isPagePanelOpen && (
        <MangaPagePanel
          currentPageIndex={currentImageIndex}
          onClose={() => setIsPagePanelOpen(false)}
          onSelectPage={handlePageSelect}
          pageCount={pageCount}
        />
      )}
      <ReaderMarksPanel
        bookId={bookId}
        resource={readerResource}
        editionSwitch={editionSwitch}
        key={`${book.id}:${session?.id ?? ''}`}
        isOpen={isMarksOpen}
        currentMarkInput={currentMarkInput}
        deletingIds={marksState.deletingIds}
        relocatingIds={marksState.relocatingIds}
        error={marksState.error}
        hasLoaded={marksState.hasLoaded}
        isLoading={marksState.isLoading}
        loadError={marksState.loadError}
        onReload={() => void marksController.load()}
        isDark
        isSaving={marksState.isSaving}
        marks={marksState.marks}
        onClose={() => setIsMarksOpen(false)}
        onCreateMark={handleCreateMark}
        onDeleteMark={handleDeleteMark}
        onSelectMark={handleSelectMark}
        onRelocateMark={handleRelocateMark}
      />
    </main>
  );
}

function MangaImagePage({
  fitMode,
  imageScale,
  imageSize,
  imageUrl,
  isActive,
  onDoubleClick,
  onImageLoad,
  onVisible,
  onReadabilityChange,
  isReadingAllowed,
  onCheckUpdate,
  title,
}: {
  fitMode: MangaPageFitMode;
  imageScale: number;
  imageSize: { width: number; height: number } | null;
  imageUrl?: string;
  isActive: boolean;
  onDoubleClick: (event: MouseEvent<HTMLImageElement>) => void;
  onImageLoad: (image: HTMLImageElement) => void;
  onVisible: () => void;
  onReadabilityChange: (visible: boolean) => void;
  isReadingAllowed: boolean;
  onCheckUpdate: () => void;
  title: string;
}) {
  const authenticatedImage = useAuthenticatedImageResource(imageUrl, { cache: false });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const onVisibleRef = useRef(onVisible);
  useLayoutEffect(() => { onVisibleRef.current = onVisible; }, [onVisible]);
  useEffect(() => {
    const image = imageRef.current;
    const viewport = image?.closest('.reader-mobile-pan');
    if (!isActive || !isReadingAllowed || !image || !viewport || !authenticatedImage.url) return;
    let active = true;
    let frame: number | undefined;
    const report = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (!active) return;
        const readable = document.visibilityState !== 'hidden' && image.complete && image.naturalWidth > 0 && isMediaPageVisible(image.getBoundingClientRect(), viewport.getBoundingClientRect());
        onReadabilityChange(readable);
        if (readable) onVisibleRef.current();
      });
    };
    const observer = new IntersectionObserver(report, { root: viewport, threshold: [0, 0.5, 1] });
    observer.observe(image);
    image.addEventListener('load', report);
    viewport.addEventListener('scroll', report, { passive: true });
    document.addEventListener('visibilitychange', report);
    report();
    return () => { active = false; onReadabilityChange(false); if (frame !== undefined) window.cancelAnimationFrame(frame); observer.disconnect(); image.removeEventListener('load', report); viewport.removeEventListener('scroll', report); document.removeEventListener('visibilitychange', report); };
  }, [authenticatedImage.url, fitMode, imageScale, isActive, isReadingAllowed, onReadabilityChange]);
  useEffect(() => { if (isActive && authenticatedImage.status === 'error') onCheckUpdate(); }, [authenticatedImage.status, isActive, onCheckUpdate]);

  // Inactive pages stay mounted solely so this hook keeps their downloaded
  // blob alive (prefetch of the upcoming pages); they render nothing.
  if (!isActive) {
    return null;
  }

  if (authenticatedImage.status === 'error') {
    return (
      <button
        className="grid aspect-[3/4] max-h-full w-full max-w-md place-items-center self-center rounded-xl border border-white/10 bg-white/[0.06] px-6 transition hover:bg-white/10"
        onClick={(event) => {
          event.stopPropagation();
          authenticatedImage.retry();
        }}
        type="button"
      >
        <span className="flex flex-col items-center gap-2 text-sm text-white/70">
          <ImageOff className="h-5 w-5" />
          图片页加载失败 · 点击重试
          {authenticatedImage.error ? <span className="text-xs text-white/45">{authenticatedImage.error}</span> : null}
        </span>
      </button>
    );
  }

  if (authenticatedImage.url) {
    return (
      <img
        alt={title}
        className="mx-auto block shrink-0 select-none animate-fade-in rounded-sm bg-black object-contain max-w-none sm:rounded-lg"
        draggable={false}
        onError={authenticatedImage.onError}
        onLoad={(event) => {
          onImageLoad(event.currentTarget);
        }}
        onDoubleClick={onDoubleClick}
        ref={imageRef}
        src={authenticatedImage.url}
        style={imageSize ?? { width: '100%', height: '100%' }}
      />
    );
  }

  return (
    <div
      aria-label="正在加载图片页"
      className="grid aspect-[3/4] max-h-full w-full max-w-md animate-pulse place-items-center self-center rounded-xl border border-white/10 bg-white/[0.06]"
      role="img"
    >
      <span className="inline-flex items-center gap-2 text-sm text-white/60">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载图片页...
      </span>
    </div>
  );
}

function parseRequestedPageIndex(searchParams: URLSearchParams): number | null {
  const requestedPageIndex = Number(searchParams.get('page'));

  return Number.isInteger(requestedPageIndex) && requestedPageIndex > 0 ? requestedPageIndex : null;
}

function clampScale(scale: number): number {
  return Math.min(3, Math.max(0.75, Number(scale.toFixed(2))));
}


