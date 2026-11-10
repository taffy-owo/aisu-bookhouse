import { getApiServerTime } from '../../../shared/api/serverClock';
import { useReaderDownload } from '../hooks/useReaderDownload';
import { ChevronLeft, ChevronRight, RefreshCcw } from 'lucide-react';
import { lazy, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getBookDetailPath, getMangaReaderPath } from '../../../config/routes';
import { useReaderChapterRefresh } from '../hooks/useReaderChapterRefresh';
import { useReaderEditionSwitch } from '../hooks/useReaderEditionSwitch';
import { acknowledgeReaderStartup, stageReaderStartup, takeReaderStartup } from '../services/readerStartupHandoff';
import { useSession } from '../../../app/SessionContext';
import { deleteBookChapter, getBrowserReaderAvailability, getEditableBookChapter, updateBookChapter } from '../../books';
import { Button } from '../../../shared/components/Button';
import type { Book } from '../../books';
import { NovelContent } from '../components/NovelContent';
import { AudiobookPlayer, type AudiobookCueChange, type AudiobookPlayRequest } from '../components/AudiobookPlayer';
import { ReaderChapterNavigation } from '../components/ReaderChapterNavigation';
import { ReaderBottomBar } from '../components/ReaderBottomBar';
import { ReaderScrollPosition } from '../components/ReaderScrollPosition';
import { ReaderReadingStatus } from '../components/ReaderReadingStatus';
import { ProgressSyncIndicator } from '../components/ProgressSyncIndicator';
import { ReaderStartupState } from '../components/ReaderStartupState';
import { ReaderMutationRecovery } from '../components/ReaderMutationRecovery';
import { ReaderFindBar } from '../components/ReaderFindBar';
import { ReaderMarksPanel } from '../components/ReaderMarksPanel';
import { ReaderSettingsPanel } from '../components/ReaderSettingsPanel';
import { ReaderTocPanel } from '../components/ReaderTocPanel';
import { ReaderTopBar } from '../components/ReaderTopBar';
import { UnsupportedReaderState } from '../components/UnsupportedReaderState';
import { JapaneseReaderToolsPanel } from '../../japanese/components/JapaneseReaderToolsPanel';
import { EditChapterDialog } from '../../library/components/EditChapterDialog';
import {
  readerBodyFontClass,
  readerContentWidthClass,
  readerFontClass,
  readerFontWeightClass,
  readerLineHeightClass,
  readerPagePaddingClass,
  readerParagraphSpacingClass,
  readerTextIndentClass,
  readerThemeClass,
} from '../constants/readerDisplayClasses';
import { cn } from '../../../shared/utils/cn';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { useMediaQuery } from '../../../shared/hooks/useMediaQuery';
import { useReaderControls } from '../hooks/useReaderControls';
import { useReaderMarksRefresh } from '../hooks/useReaderMarksRefresh';
import { useReaderCatalogRefresh } from '../hooks/useReaderCatalogRefresh';
import { useReaderKeyboardShortcuts } from '../hooks/useReaderKeyboardShortcuts';
import { isReaderEdgePageTarget, isReaderInteractiveTarget, useReaderTouchGestures } from '../hooks/useReaderTouchGestures';
import { usePagedReading } from '../hooks/usePagedReading';
import { useReaderLayoutAnchor } from '../hooks/useReaderLayoutAnchor';
import { useReaderChromeLayout } from '../hooks/useReaderChromeLayout';
import { useReadingActivityTracker } from '../hooks/useReadingActivityTracker';
import { useReadingProgress } from '../hooks/useReadingProgress';
import { createReaderMark, deleteReaderMark, getReaderMarks, relocateReaderMark } from '../services/readerMarkService';
import { createReaderMarksController } from '../services/readerMarksController';
import { readChapterPosition, reconcileChapterPositionReset, resolveChapterAnchor, resolveChapterPosition, resolveInitialChapterProgress, saveChapterPosition } from '../services/chapterPositionHistory';
import { createReadingProgressTimestamp } from '../services/progressTimestamp';
import { readReaderPreferences, saveReaderPreferences, type ReaderPreferences } from '../services/readerPreferences';
import { getReaderStartupError, type ReaderStartupError } from '../services/readerStartupError';
import { convertReaderTocToSimplified, convertTraditionalToSimplified } from '../services/chineseScriptConversion';
import { flushAllReadingProgressSyncs, flushReadingProgressSync, getPendingReadingProgress, queueReadingProgressSync } from '../services/readingProgressSync';
import { getAccountScope } from '../../../shared/api';
import { getReaderChapter, getReaderResource, getReaderStartup, prefetchReaderChapters, resetReaderChapterCache } from '../services/readerService';
import { getMobileSafariReaderEnvironment, shouldUseMobileDocumentScroll } from '../services/mobileSafariReader';
import { createChapterEditor } from '../services/chapterEditor';
import { readerPageIdentity, reconcileReaderResource } from '../services/readerResourceRefresh';
import { applyReaderBrowserChromeTheme } from '../services/readerBrowserChrome';
import { getPdfProgressPercent } from '../services/pdfReaderLayout';
import { isMediaProgressBoundToResource, resolveInitialMediaProgress, shouldSaveVisibleMediaProgress } from '../services/mediaReadingProgress';
import type { ChapterLoadState, ReaderResourceLoadState } from '../types/novelReaderState';
import type { ReaderMark, ReaderMarkCreateInput, ReaderResource, ReadingProgress } from '../types/reader';
import { clampChapterIndex, parseRequestedChapterIndex } from '../utils/chapterNavigation';
import { AUDIOBOOK_FOLLOW_EVENT } from '../utils/audiobookTextFollow';
import { getChapterSearchText } from '../utils/readerContent';
import { captureChapterSourceAnchor, createReaderSourceSnapshot, rebaseEditedChapterAnchor, resolveChapterSourceAnchor } from '../utils/readerEditedAnchor';
import { resolveReaderMarkTarget } from '../utils/readerMarkTarget';
import { decodeChapterScrollRatio, encodeChapterScrollRatio, getChapterProgressPercent } from '../utils/chapterScrollPosition';
import { getContentScrollRatio, getReaderContentScrollEnd } from '../utils/readerScrollMetrics';
import { canDockReaderToc } from '../utils/readerTocDocking';
import { captureReaderViewportAnchor, restoreReaderViewportAnchor, type ReaderViewportAnchor } from '../utils/readerViewportAnchor';
import { estimateReadingMinutes, formatReadingMinutes } from '../utils/readerMetrics';
import { isJapaneseBook } from '../../japanese/services/japaneseBooks';
import { getJapaneseSelectionText } from '../../japanese/services/japaneseSelectionText';
import {
  readJapaneseFuriganaMode,
  readJapaneseLayout,
  readJapaneseTranslationMode,
  saveJapaneseFuriganaMode,
  saveJapaneseLayout,
  saveJapaneseTranslationMode,
  type JapaneseFuriganaMode,
  type JapaneseTranslationMode,
} from '../../japanese/services/japaneseLayoutPreferences';

const PdfReader = lazy(() => import('../components/PdfReader').then((module) => ({ default: module.PdfReader })));
const CHAPTER_PREFETCH_AHEAD = 3;

export function NovelReaderPage() {
  const { session } = useSession();
  const { bookId = '' } = useParams();
  const location = useLocation();
  const { state: navigationState } = location;
  const startupNavigationStateRef = useRef(navigationState);
  useLayoutEffect(() => { startupNavigationStateRef.current = navigationState; }, [navigationState]);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [book, setBook] = useState<Book | null>(null);
  const [startupError, setStartupError] = useState<ReaderStartupError | null>(null);
  const [startupRetryKey, setStartupRetryKey] = useState(0);
  const [pdfPageRequest, setPdfPageRequest] = useState<{ bookId: string; pageNumber: number } | null>(null);
  const [chapterRetryKey, setChapterRetryKey] = useState(0);
  const [chapterIndex, setChapterIndex] = useState(1);
  const [chapterState, setChapterState] = useState<ChapterLoadState>({
    bookId: '',
    chapter: null,
    chapterIndex: 0,
    error: null,
    isLoading: true,
  });
  const [readerResourceState, setReaderResourceState] = useState<ReaderResourceLoadState>({
    bookId: '',
    isLoaded: false,
    resource: null,
  });
  const download = useReaderDownload(bookId);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [isMarksOpen, setIsMarksOpen] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [isScrollPositionDragging, setIsScrollPositionDragging] = useState(false);
  const [isJapaneseToolsOpen, setIsJapaneseToolsOpen] = useState(false);
  const [isAudiobookOpen, setIsAudiobookOpen] = useState(false);
  const [audiobookCue, setAudiobookCue] = useState<AudiobookCueChange | null>(null);
  const [audiobookPlayRequest, setAudiobookPlayRequest] = useState<AudiobookPlayRequest>({ chapterIndex: 1, id: 0 });
  const [findQuery, setFindQuery] = useState('');
  const [activeFindMatchIndex, setActiveFindMatchIndex] = useState(0);
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [selectedReaderText, setSelectedReaderText] = useState('');
  const [readerPreferences, setReaderPreferences] = useState<ReaderPreferences>(() => readReaderPreferences());
  const chapterEditor = useMemo(() => {
    // Recreate the controller when the account changes so an old editor
    // cannot publish into the next account's reader.
    void session?.id;
    return createChapterEditor(bookId, {
      getEditableBookChapter,
      updateBookChapter,
      deleteBookChapter,
      getReaderChapter,
      getReaderResource,
      resetReaderChapterCache,
    });
  }, [bookId, session?.id]);
  const chapterEditState = useSyncExternalStore(chapterEditor.subscribe, chapterEditor.getSnapshot);
  const cancelPendingChapterEdit = useCallback(() => {
    // A later reading action owns the user's attention. Invalidate only an
    // unfinished read, so its response cannot open an editor over the new view.
    if (chapterEditor.getSnapshot().isLoading) chapterEditor.close();
  }, [chapterEditor]);
  const handleOpenSettings = useCallback(() => {
    cancelPendingChapterEdit();
    setIsSettingsOpen(true);
  }, [cancelPendingChapterEdit]);
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

  useEffect(() => () => chapterEditor.invalidate(), [chapterEditor]);
  useEffect(() => () => marksController.reset(), [marksController]);

  const [japaneseFuriganaMode, setJapaneseFuriganaMode] = useState<JapaneseFuriganaMode>('on-demand');
  const [japaneseTranslationMode, setJapaneseTranslationMode] = useState<JapaneseTranslationMode>('off');
  const [chapterScrollRatio, setChapterScrollRatio] = useState(0);
  const [hasRestoredChapterScroll, setHasRestoredChapterScroll] = useState(false);
  const [chapterScrollRestoreRequest, setChapterScrollRestoreRequest] = useState(0);
  const readerShellRef = useRef<HTMLElement | null>(null);
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const latestChapterScrollRatioRef = useRef(0);
  const isRestoringChapterScrollRef = useRef(false);
  const detectRestoredScrollIntentRef = useRef<(() => void) | null>(null);
  const pendingChapterEndRef = useRef(false);
  const latestProgressUpdatedAtRef = useRef(createReadingProgressTimestamp(undefined, bookId));
  const latestPdfProgressRef = useRef<ReadingProgress | null>(null);
  const [pdfPageCountState, setPdfPageCountState] = useState<{ bookId: string; scope: string; positionKey?: string; count: number } | null>(null);
  const isNavigatingRef = useRef(false);
  const pendingChapterNavigationRef = useRef<{
    bookId: string;
    scope: string;
    chapterIndex: number;
    positionKey?: string;
    ratio: number;
    anchor?: ReaderViewportAnchor;
  } | null>(null);
  // Whether the user actually read (scrolled / navigated chapters) in this
  // session. Teardown/pagehide saves are skipped otherwise, so a tab that was
  // merely opened on stale progress can never overwrite progress written by
  // another device.
  const hasUserInteractedRef = useRef(false);
  const hasDesktopPointer = useMediaQuery('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
  const hasCoarsePointer = useMediaQuery('(pointer: coarse)');
  const hasTouchPointer = useMediaQuery('(any-pointer: coarse)');
  const [hasFullReaderViewport, setHasFullReaderViewport] = useState(() => canDockReaderToc(window.visualViewport, window.innerWidth, window.innerHeight));
  // A touch-capable laptop still needs chapter links when using its mouse.
  const isTouchReader = hasCoarsePointer || (!hasDesktopPointer && hasTouchPointer);
  const isTocDocked = isTocOpen && hasDesktopPointer && hasFullReaderViewport && readerPreferences.readingMode === 'scroll';
  const isBlockingReaderPanelOpen = isSettingsOpen || (isTocOpen && !isTocDocked) || isMarksOpen || isJapaneseToolsOpen || chapterEditState.chapter !== null;
  const isReaderInteractionBlocked = isBlockingReaderPanelOpen || isFindOpen || chapterEditState.needsRefresh;
  const controls = useReaderControls(false, isBlockingReaderPanelOpen || isFindOpen || isScrollPositionDragging);
  const theme = readerPreferences.theme;
  const isDarkTheme = theme === 'dark';
  const isJapanese = Boolean(book && isJapaneseBook(book));
  const isChinese = book?.language === 'zh';
  const chineseScript = isChinese ? readerPreferences.chineseScript : 'original';
  const readingProgress = useReadingProgress(null);
  const restoredChapterScrollRef = useRef(hasRestoredChapterScroll);
  useLayoutEffect(() => { restoredChapterScrollRef.current = hasRestoredChapterScroll; }, [hasRestoredChapterScroll]);
  const latestReadingProgressRef = useRef(readingProgress.progress);
  useLayoutEffect(() => { latestReadingProgressRef.current = readingProgress.progress; }, [readingProgress.progress]);
  const { resetProgress, updateProgress } = readingProgress;
  const savedProgressPercent = readingProgress.progress?.progressPercent ?? book?.progressPercent ?? 0;
  const mediaAccountScopeRef = useRef<string | null>(null);
  const isReaderResourceLoaded = readerResourceState.bookId === bookId && readerResourceState.isLoaded;
  const readerResource = isReaderResourceLoaded ? readerResourceState.resource : null;
  const contentCheck = useReaderCatalogRefresh(bookId, book?.publicationStatus, isReaderResourceLoaded, isTocOpen, setReaderResourceState);
  const pendingResource = isReaderResourceLoaded ? readerResourceState.pendingResource : undefined;
  const reloadEdition = useCallback(() => setStartupRetryKey((key) => key + 1), []);
  const editionSwitch = useReaderEditionSwitch(bookId, pendingResource, reloadEdition);
  const chapterResource = readerResource && 'chapterCount' in readerResource ? readerResource : null;
  const pdfResource = readerResource && 'fileUrl' in readerResource ? readerResource : null;
  const activePdfResourceRef = useRef({ bookId, resource: pdfResource });
  useLayoutEffect(() => { activePdfResourceRef.current = { bookId, resource: pdfResource }; }, [bookId, pdfResource]);
  const handlePdfPageCountChange = useCallback((count: number) => {
    const scope = getAccountScope();
    if (mediaAccountScopeRef.current !== scope || activePdfResourceRef.current.bookId !== bookId
      || activePdfResourceRef.current.resource?.positionKey !== pdfResource?.positionKey) return;
    setPdfPageCountState(previous => previous?.bookId === bookId && previous.scope === scope
      && previous.positionKey === pdfResource?.positionKey && previous.count === count ? previous
      : { bookId, scope, positionKey: pdfResource?.positionKey, count });
  }, [bookId, pdfResource?.positionKey]);
  const readerMarkResource = useMemo<ReaderResource | null>(() => !pdfResource ? readerResource : {
    ...pdfResource,
    pageCount: pdfPageCountState?.bookId === bookId && pdfPageCountState.scope === getAccountScope()
      && pdfPageCountState.positionKey === pdfResource.positionKey ? pdfPageCountState.count : undefined,
  }, [bookId, pdfPageCountState, pdfResource, readerResource]);
  useLayoutEffect(() => { latestPdfProgressRef.current = null; }, [bookId, pdfResource?.positionKey]);
  // The backend gives PDF readers a scoped URL ticket. Passing it straight to
  // the native viewer preserves HTTP Range streaming and avoids a full-size
  // authenticated Blob copy in browser memory.
  const pdfPreviewUrl = pdfResource?.fileUrl;
  const refreshPdfUrl = useCallback(async (signal: AbortSignal) => {
    const scope = getAccountScope();
    const resource = await getReaderResource(bookId, signal);
    if (signal.aborted || getAccountScope() !== scope || activePdfResourceRef.current.bookId !== bookId) throw new DOMException('已取消旧阅读器请求', 'AbortError');
    setReaderResourceState((current) => signal.aborted || getAccountScope() !== scope ? current : reconcileReaderResource(current, bookId, resource, true));
    const currentIdentity = readerPageIdentity(activePdfResourceRef.current.resource);
    if (resource.readerType !== 'pdf' || (currentIdentity && currentIdentity !== readerPageIdentity(resource))) throw new Error('阅读文件已更新，请先打开新版阅读器。');
    if (!resource.fileUrl) throw new Error('PDF 访问地址不可用');
    return resource.fileUrl;
  }, [bookId]);
  const pdfInitialPage = readingProgress.progress?.readerType === 'pdf' ? (readingProgress.progress.pageNumber ?? 1) : 1;
  const chapterCount = chapterResource?.chapterCount ?? 0;
  const safeChapterCount = Math.max(chapterCount, 1);
  const chapterProgressWeights = useMemo(() => chapterResource?.toc.map((item) => item.progressWeight), [chapterResource?.toc]);
  const effectiveChapterIndex = chapterCount > 0 ? clampChapterIndex(chapterIndex, chapterCount) : Math.max(1, chapterIndex);
  const toc = useMemo(() => chapterResource?.toc ?? [], [chapterResource?.toc]);
  const displayToc = useMemo(() => chineseScript === 'simplified' ? convertReaderTocToSimplified(toc) : toc, [chineseScript, toc]);
  const activeChapterState = chapterState.bookId === bookId && chapterState.chapterIndex === effectiveChapterIndex ? chapterState : null;
  const canLoadChapter = Boolean(book && readerResource && chapterResource && book.readerType !== 'pdf' && book.readerType !== 'comic' && book.readerType !== 'image' && chapterCount > 0);
  const isPagedMode = readerPreferences.readingMode === 'paged' && canLoadChapter;
  const usesDocumentScroll = useMemo(
    () => canLoadChapter && !isPagedMode && shouldUseMobileDocumentScroll(getMobileSafariReaderEnvironment()),
    [canLoadChapter, isPagedMode],
  );
  const getReaderScrollElement = useCallback((): HTMLElement | null => {
    if (usesDocumentScroll) {
      return (document.scrollingElement ?? document.documentElement) as HTMLElement;
    }
    return readerShellRef.current;
  }, [usesDocumentScroll]);
  const chapter = canLoadChapter ? (activeChapterState?.chapter ?? null) : null;
  const chapterAnchorHintRef = useRef({ key: '', blockIndex: 0 });
  const usesSimplifiedSource = book?.language === 'zh' && chineseScript === 'simplified';
  const chapterSource = useMemo(() => chapter ? createReaderSourceSnapshot(chapter, usesSimplifiedSource) : null, [chapter, usesSimplifiedSource]);
  const captureChapterAnchor = useCallback(() => {
    const shell = readerShellRef.current;
    const scroller = getReaderScrollElement();
    if (!shell?.isConnected || !scroller || !shell.querySelector('.reader-body-text')) return null;
    const key = `${bookId}:${effectiveChapterIndex}`;
    const hint = chapterAnchorHintRef.current;
    const anchor = captureReaderViewportAnchor(shell, scroller, hint.key === key ? hint.blockIndex : 0, true);
    if (anchor) chapterAnchorHintRef.current = { key, blockIndex: anchor.blockIndex };
    return captureChapterSourceAnchor(anchor, chapterSource);
  }, [bookId, chapterSource, effectiveChapterIndex, getReaderScrollElement]);
  const chapterPositionKey = chapter?.positionKey;
  const currentTocPositionKey = toc.find((item) => item.index === effectiveChapterIndex)?.positionKey;
  const currentTocContentVersion = toc.find((item) => item.index === effectiveChapterIndex)?.contentVersion;
  const isChapterOutdated = Boolean(chapter && ((chapterPositionKey && toc.some((item) => item.positionKey) && currentTocPositionKey !== chapterPositionKey)
    || (chapter.contentVersion && currentTocContentVersion && chapter.contentVersion !== currentTocContentVersion)));
  const latestPositionKeysRef = useRef({ bookId, pending: Boolean(pendingResource), readerType: readerResource?.readerType, keys: new Map<number, string>(), versions: new Map<number, string>(), hasKeys: false });
  useLayoutEffect(() => {
    latestPositionKeysRef.current = {
      bookId, pending: Boolean(pendingResource), readerType: pendingResource?.readerType ?? readerResource?.readerType,
      keys: new Map(toc.flatMap((item) => item.positionKey ? [[item.index, item.positionKey] as const] : [])),
      versions: new Map(toc.flatMap((item) => item.contentVersion ? [[item.index, item.contentVersion] as const] : [])),
      hasKeys: toc.some((item) => item.positionKey),
    };
  }, [bookId, pendingResource, readerResource, toc]);
  const canPersistChapterPosition = useCallback((index: number, key?: string, version?: string) => {
    // Check the live controller: teardown may still hold the old render after
    // a confirmed mutation has made its chapter indexes or text obsolete.
    if (chapterEditor.getSnapshot().needsRefresh) return false;
    const latest = latestPositionKeysRef.current;
    if (latest.bookId !== bookId) return true;
    if (latest.pending) return false;
    if (latest.readerType && latest.readerType !== 'text' && latest.readerType !== 'epub') return false;
    return (!key || !latest.hasKeys || latest.keys.get(index) === key)
      && (!version || !latest.versions.has(index) || latest.versions.get(index) === version);
  }, [bookId, chapterEditor]);
  const chapterError = canLoadChapter ? (activeChapterState?.error ?? null) : null;
  const isChapterLoading = canLoadChapter ? (activeChapterState?.isLoading ?? true) : false;
  const isTopReaderControlsVisible = controls.isControlsVisible || (hasDesktopPointer && !isPagedMode) || isChapterLoading || Boolean(chapterError);
  const progressPercent = chapterCount > 0 && chapter && !isChapterLoading
    ? getChapterProgressPercent(effectiveChapterIndex, safeChapterCount, chapterScrollRatio, chapterProgressWeights)
    : savedProgressPercent;
  const chapterSearchText = useMemo(() => {
    const sourceText = getChapterSearchText(chapter?.blocks, chapter?.content ?? '');
    return chineseScript === 'simplified'
      ? convertTraditionalToSimplified(sourceText)
      : sourceText;
  }, [chapter?.blocks, chapter?.content, chineseScript]);
  const estimatedChapterMinutes = useMemo(() => estimateReadingMinutes(chapterSearchText), [chapterSearchText]);
  const remainingChapterMinutes = estimatedChapterMinutes ? Math.ceil(estimatedChapterMinutes * (1 - chapterScrollRatio)) : 0;
  const remainingChapterCount = Math.max(0, safeChapterCount - effectiveChapterIndex);
  const readingMetaLabel = estimatedChapterMinutes
    ? `本章 ${formatReadingMinutes(estimatedChapterMinutes)} · 剩 ${formatReadingMinutes(remainingChapterMinutes)} · 还剩 ${remainingChapterCount} 章`
    : undefined;
  // PDF reading happens in the iframe branch below and never satisfies
  // canLoadChapter, so it needs its own activation condition — otherwise PDF
  // sessions are never counted as reading time.
  useReadingActivityTracker(canLoadChapter && !isChapterLoading && Boolean(chapter) && hasRestoredChapterScroll && !isBlockingReaderPanelOpen && !chapterEditState.needsRefresh, bookId);

  useEffect(() => applyReaderBrowserChromeTheme(theme), [theme]);

  // Set when startup preloaded the first chapter, so the chapter effect can
  // skip re-fetching it. Cleared after the first check.
  const preloadedChapterRef = useRef<{ bookId: string; chapterIndex: number } | null>(null);

  useEffect(() => {
    if (!usesDocumentScroll) return undefined;

    const previousScrollTop = document.scrollingElement?.scrollTop ?? window.scrollY;
    document.documentElement.classList.add('reader-document-scroll-active');
    document.body.classList.add('reader-document-scroll-active');
    return () => {
      document.documentElement.classList.remove('reader-document-scroll-active');
      document.body.classList.remove('reader-document-scroll-active');
      window.scrollTo(0, previousScrollTop);
    };
  }, [usesDocumentScroll]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const accountScope = getAccountScope();
    mediaAccountScopeRef.current = null;

    // Read ?chapter= directly from the location so later in-reader URL
    // rewrites (history.replaceState on chapter change) cannot re-trigger
    // this startup effect and reload the whole book.
    const recoveryChapterIndex = chapterEditor.getSnapshot().refreshChapterIndex;
    const requestedChapterIndex = recoveryChapterIndex ?? parseRequestedChapterIndex(new URLSearchParams(window.location.search)) ?? undefined;

    setBook(null);
    setStartupError(null);
    setReaderResourceState({ bookId, isLoaded: false, resource: null });
    setChapterState({ bookId, chapter: null, chapterIndex: requestedChapterIndex ?? 1, error: null, isLoading: true });
    resetProgress();
    marksController.reset();
    setSelectedReaderText('');
    setHasRestoredChapterScroll(false);
    latestChapterScrollRatioRef.current = 0;
    hasUserInteractedRef.current = false;
    pendingChapterNavigationRef.current = null;
    isNavigatingRef.current = false;

    // Keep the queued position across the startup request: its PUT may finish
    // and clear the outbox after the server has already taken an older snapshot.
    const pendingAtStartup = getPendingReadingProgress(bookId);
    const handoff = recoveryChapterIndex === null ? takeReaderStartup(bookId) : null;
    void (handoff ? Promise.resolve(handoff) : getReaderStartup(bookId, requestedChapterIndex, controller.signal))
      .then((startup) => {
        if (isMounted && !controller.signal.aborted && getAccountScope() === accountScope) {
          if (startup.resource.readerType === 'comic' || startup.resource.readerType === 'image') {
            stageReaderStartup(bookId, startup, getPendingReadingProgress(bookId) ?? pendingAtStartup);
            navigate(getMangaReaderPath(bookId), { replace: true, state: startupNavigationStateRef.current });
            return;
          }
          acknowledgeReaderStartup(bookId, startup);
          mediaAccountScopeRef.current = accountScope;
          const pendingProgress = getPendingReadingProgress(bookId) ?? pendingAtStartup;
          reconcileChapterPositionReset(startup.progress);
          const initialProgress = resolveInitialChapterProgress(startup.resource,
            resolveInitialMediaProgress(startup.resource, startup.progress, pendingProgress), pendingProgress);
          const nextChapterIndex = requestedChapterIndex ?? initialProgress.chapterIndex ?? 1;
          // Startup may have preloaded the server's old chapter while a newer
          // local position was still syncing. Fetch the selected chapter instead.
          const initialChapter = startup.chapter?.index === nextChapterIndex ? startup.chapter : null;
          setBook(startup.book);
          setReaderResourceState({ bookId, isLoaded: true, resource: startup.resource });
          updateProgress(initialProgress);
          latestProgressUpdatedAtRef.current = initialProgress.updatedAt;
          const serverRatio = initialProgress.chapterIndex === nextChapterIndex ? decodeChapterScrollRatio(initialProgress.epubCfi) : null;
          const initialRatio = resolveChapterPosition({
            chapterIndex: nextChapterIndex,
            localPosition: readChapterPosition(bookId, nextChapterIndex, initialChapter?.positionKey ?? ('toc' in startup.resource ? startup.resource.toc.find((item) => item.index === nextChapterIndex)?.positionKey : undefined)),
            serverChapterIndex: initialProgress.chapterIndex,
            serverRatio,
            serverUpdatedAt: initialProgress.updatedAt,
          });
          setChapterIndex(nextChapterIndex);
          setChapterScrollRatio(initialRatio);
          latestChapterScrollRatioRef.current = initialRatio;
          marksController.seed(startup.marks);
          if (initialChapter) {
            preloadedChapterRef.current = { bookId, chapterIndex: nextChapterIndex };
          }
          setChapterState({
            bookId,
            chapter: initialChapter,
            chapterIndex: nextChapterIndex,
            error: null,
            isLoading: Boolean(initialChapter === null && 'chapterCount' in startup.resource && startup.resource.readerType !== 'unsupported' && startup.resource.chapterCount > 0),
          });
          if (recoveryChapterIndex !== null) {
            chapterEditor.clearMessage();
            navigate({ search: `?chapter=${nextChapterIndex}` }, { replace: true, state: startupNavigationStateRef.current });
          }
        }
      })
      .catch((error: unknown) => {
        if (isMounted && !controller.signal.aborted && getAccountScope() === accountScope) {
          setBook(null);
          setStartupError(getReaderStartupError(error));
          setReaderResourceState({ bookId, isLoaded: true, resource: null });
          setChapterState({ bookId, chapter: null, chapterIndex: requestedChapterIndex ?? 1, error: null, isLoading: false });
        }
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [bookId, chapterEditor, marksController, navigate, resetProgress, session?.id, startupRetryKey, updateProgress]);

  useEffect(() => {
    if (!canLoadChapter) {
      return;
    }
    // Startup already delivered this exact chapter — consume the marker and
    // skip the redundant fetch. (Depending on chapterState here instead would
    // re-run this effect mid-load and fire every chapter request twice.)
    const preloaded = preloadedChapterRef.current;
    if (preloaded && preloaded.bookId === bookId && preloaded.chapterIndex === effectiveChapterIndex) {
      preloadedChapterRef.current = null;
      return;
    }
    preloadedChapterRef.current = null;

    let isMounted = true;
    const controller = new AbortController();

    setChapterState({ bookId, chapter: null, chapterIndex: effectiveChapterIndex, error: null, isLoading: true });
    void getReaderChapter(bookId, effectiveChapterIndex, controller.signal)
      .then((nextChapter) => {
        if (isMounted && !controller.signal.aborted) {
          setHasRestoredChapterScroll(false);
          setChapterState({ bookId, chapter: nextChapter, chapterIndex: effectiveChapterIndex, error: null, isLoading: false });
        }
      })
      .catch((error: unknown) => {
        if (isMounted && !controller.signal.aborted) {
          setChapterState({ bookId, chapter: null, chapterIndex: effectiveChapterIndex, error: error instanceof Error ? error.message : '正文加载失败', isLoading: false });
        }
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [bookId, canLoadChapter, chapterRetryKey, effectiveChapterIndex]);

  useEffect(() => {
    if (canLoadChapter && !isChapterLoading) {
      void prefetchUpcomingChapters(bookId, effectiveChapterIndex, chapterCount);
    }
  }, [bookId, canLoadChapter, chapterCount, effectiveChapterIndex, isChapterLoading]);

  useEffect(() => {
    saveReaderPreferences(readerPreferences);
  }, [readerPreferences]);

  useEffect(() => {
    if (book && isJapaneseBook(book)) {
      const savedLayout = readJapaneseLayout(book.id);
      setJapaneseFuriganaMode(readJapaneseFuriganaMode(book.id));
      setJapaneseTranslationMode(readJapaneseTranslationMode(book.id));
      setReaderPreferences((current) => current.japaneseLayout === savedLayout ? current : { ...current, japaneseLayout: savedLayout });
    } else {
      setIsJapaneseToolsOpen(false);
    }
  }, [book]);

  useEffect(() => {
    if (!book) {
      return;
    }
    document.title = `${chapter?.title || book.currentChapter || '阅读中'} · ${book.title} - 爱素书屋`;

    return () => {
      document.title = '爱素书屋';
    };
  }, [book, chapter?.title]);

  useEffect(() => {
    setSelectedReaderText('');
    setActiveFindMatchIndex(0);
  }, [bookId, effectiveChapterIndex]);

  useEffect(() => {
    if (!findMatchCount) {
      setActiveFindMatchIndex(0);
      return;
    }

    setActiveFindMatchIndex((currentIndex) => Math.min(currentIndex, findMatchCount - 1));
  }, [findMatchCount]);

  useEffect(() => {
    if (!isFindOpen || !findQuery.trim() || !findMatchCount) {
      return;
    }

    const shell = readerShellRef.current;
    const scroller = getReaderScrollElement();
    const findBar = readerRootRef.current?.querySelector<HTMLElement>('.reader-find-bar');
    if (!shell || !scroller || !findBar) return;
    let frame = 0;
    const positionMatch = () => {
      frame = 0;
      const mark = shell.querySelector<HTMLElement>('[data-reader-search-active="true"]');
      if (!mark) return;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const footer = readerRootRef.current?.querySelector<HTMLElement>('.reader-bottom-bar');
      const shellBounds = shell.getBoundingClientRect();
      const top = Math.max(viewportTop, shellBounds.top, findBar.getBoundingClientRect().bottom) + 12;
      const bottom = Math.min(viewportBottom, usesDocumentScroll ? viewportBottom : shellBounds.bottom,
        footer && !footer.inert ? footer.getBoundingClientRect().top : viewportBottom) - 12;
      if (bottom <= top) return;
      const bounds = mark.getBoundingClientRect();
      scroller.scrollTop += (bounds.top + bounds.bottom - top - bottom) / 2;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(positionMatch); };
    const observer = new ResizeObserver(schedule);
    observer.observe(findBar);
    observer.observe(shell);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [activeFindMatchIndex, findMatchCount, findQuery, getReaderScrollElement, isFindOpen, usesDocumentScroll]);

  const buildChapterProgress = useCallback(
    (scrollRatio: number, nextChapterIndex: number, positionKey?: string): ReadingProgress => ({
      bookId,
      positionKey,
      contentVersion: chapter?.contentVersion,
      chapterIndex: nextChapterIndex,
      epubCfi: encodeChapterScrollRatio(scrollRatio),
      progressPercent: getChapterProgressPercent(nextChapterIndex, safeChapterCount, scrollRatio, chapterProgressWeights),
      readerType: book?.readerType,
      updatedAt: latestProgressUpdatedAtRef.current,
    }),
    [book?.readerType, bookId, chapter?.contentVersion, chapterProgressWeights, safeChapterCount],
  );

  const onRestoreLayoutPosition = useCallback((ratio: number) => {
    if (!canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion)) return;
    if (Math.abs(ratio - latestChapterScrollRatioRef.current) < 0.00001) return;
    latestChapterScrollRatioRef.current = ratio;
    latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
    hasUserInteractedRef.current = true;
    setChapterScrollRatio(ratio);
    const progress = buildChapterProgress(ratio, effectiveChapterIndex, chapterPositionKey);
    saveChapterPosition(bookId, effectiveChapterIndex, ratio, progress.updatedAt, chapterPositionKey, captureChapterAnchor());
    updateProgress(progress);
    void queueReadingProgressSync(bookId, progress);
  }, [bookId, buildChapterProgress, canPersistChapterPosition, captureChapterAnchor, chapter?.contentVersion, chapterPositionKey, effectiveChapterIndex, updateProgress]);
  const isRestoringPosition = useCallback(() => isRestoringChapterScrollRef.current || pendingChapterEndRef.current, []);
  const { isPositionPending, preservePosition } = useReaderLayoutAnchor({
    contentKey: `${bookId}:${effectiveChapterIndex}`,
    enabled: Boolean(canLoadChapter && chapter && !isChapterLoading && hasRestoredChapterScroll),
    getScrollElement: getReaderScrollElement,
    isPanelOpen: isReaderInteractionBlocked,
    isRestoringPosition,
    layoutKey: `${getReaderLayoutKey(readerPreferences, japaneseFuriganaMode, japaneseTranslationMode)}:${isTocDocked}`,
    onRestore: onRestoreLayoutPosition,
    shellRef: readerShellRef,
  });
  const handleAudiobookChapterComplete = useCallback((completedChapterIndex: number, followText: boolean) => {
    setAudiobookCue(null);
    if (!followText || isPagedMode || completedChapterIndex !== effectiveChapterIndex || isChapterLoading
      || !hasRestoredChapterScroll || isReaderInteractionBlocked || isPositionPending()) return;
    const scroller = getReaderScrollElement();
    if (!scroller) return;
    // Finish following the last lines before automatic navigation saves this chapter.
    readerShellRef.current?.dispatchEvent(new Event(AUDIOBOOK_FOLLOW_EVENT, { bubbles: true }));
    scroller.scrollTop = getReaderContentScrollEnd(scroller);
    onRestoreLayoutPosition(1);
  }, [effectiveChapterIndex, getReaderScrollElement, hasRestoredChapterScroll, isChapterLoading, isPagedMode, isPositionPending, isReaderInteractionBlocked, onRestoreLayoutPosition]);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = canDockReaderToc(viewport, window.innerWidth, window.innerHeight);
      if (next === hasFullReaderViewport) return;
      // Pinch zoom does not resize the layout viewport. Capture the reading
      // anchor before changing sidebar mode, just as an explicit open/close does.
      if (isTocOpen) preservePosition();
      setHasFullReaderViewport(next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    update();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [hasFullReaderViewport, isTocOpen, preservePosition]);
  const handleOpenToc = () => {
    if (isTocOpen) {
      if (isTocDocked) preservePosition();
      controls.hideControls();
      setIsTocOpen(false);
      return;
    }
    if (!hasDesktopPointer || isPagedMode) cancelPendingChapterEdit();
    if (hasDesktopPointer && !isPagedMode) preservePosition();
    // Modal catalogs return keyboard focus to their still-visible opener.
    if (hasDesktopPointer && hasFullReaderViewport && !isPagedMode) controls.hideControls();
    else controls.showControls();
    setIsTocOpen(true);
  };
  const handleCloseToc = () => {
    if (isTocDocked) preservePosition();
    controls.hideControls();
    setIsTocOpen(false);
  };
  const changeReaderPreferences = useCallback((next: ReaderPreferences) => {
    if (getReaderLayoutKey(next) !== getReaderLayoutKey(readerPreferences)) preservePosition();
    if (isTocDocked && next.readingMode === 'paged') setIsTocOpen(false);
    setReaderPreferences(next);
  }, [isTocDocked, preservePosition, readerPreferences]);

  const handlePdfPageChange = useCallback((pageNumber: number, pageCount: number, initial = false, hasReadPageEnd = true) => {
    if (book?.readerType !== 'pdf' || pendingResource || mediaAccountScopeRef.current !== getAccountScope()) return;
    const nextProgress: ReadingProgress = {
      bookId,
      pageNumber,
      positionKey: pdfResource?.positionKey,
      progressPercent: getPdfProgressPercent(pageNumber, pageCount, hasReadPageEnd),
      readerType: 'pdf',
      updatedAt: createReadingProgressTimestamp(latestPdfProgressRef.current?.updatedAt ?? readingProgress.progress?.updatedAt, bookId),
    };
    const pending = getPendingReadingProgress(bookId);
    const needsRebase = pending && pdfResource && !isMediaProgressBoundToResource(pending, pdfResource);
    if (!shouldSaveVisibleMediaProgress(readingProgress.progress, nextProgress, initial)) {
      if (!needsRebase) return;
      nextProgress.progressPercent = readingProgress.progress?.progressPercent ?? nextProgress.progressPercent;
    }
    latestPdfProgressRef.current = nextProgress;
    updateProgress(nextProgress);
    // Queue progress while the reader is changing pages. The sync service
    // coalesces rapid updates and flushes in the background; forcing a PUT
    // during navigation races the chapter request and creates a false
    // "request failed" toast even when the chapter loaded successfully.
    void queueReadingProgressSync(bookId, nextProgress);
  }, [book?.readerType, bookId, pdfResource, pendingResource, readingProgress.progress, updateProgress]);

  const flushPdfProgress = useCallback(() => {
    const latestProgress = latestPdfProgressRef.current;
    if (!latestProgress || latestProgress.bookId !== bookId || latestPositionKeysRef.current.pending) return;
    void queueReadingProgressSync(bookId, latestProgress)
      .then(() => flushReadingProgressSync(bookId, { keepalive: true }))
      .catch(() => {
        // The sync indicator keeps the pending record and retries in the
        // background. Do not cover readable content with a raw browser
        // "Failed to fetch" toast when a page is being left.
      });
  }, [bookId]);

  const applyRefreshedChapter = useCallback((next: NonNullable<ChapterLoadState['chapter']>) => {
    const sameChapter = Boolean(chapterPositionKey && chapterPositionKey === next.positionKey);
    const anchor = sameChapter ? rebaseEditedChapterAnchor(captureChapterAnchor(), chapter, next, usesSimplifiedSource) : undefined;
    const ratio = sameChapter ? latestChapterScrollRatioRef.current : 0;
    if (scrollSaveTimerRef.current) { window.clearTimeout(scrollSaveTimerRef.current); scrollSaveTimerRef.current = null; }
    pendingChapterNavigationRef.current = { bookId, scope: getAccountScope(), chapterIndex: next.index, positionKey: next.positionKey, ratio, anchor };
    preloadedChapterRef.current = { bookId, chapterIndex: next.index };
    isNavigatingRef.current = true;
    setHasRestoredChapterScroll(false);
    setChapterScrollRestoreRequest(request => request + 1);
    setChapterIndex(next.index);
    setChapterState({ bookId, chapter: next, chapterIndex: next.index, error: null, isLoading: false });
    // Return to the updated text. Closing the sheet also releases its document
    // scroll lock before restoration; the independent note draft stays intact.
    setIsMarksOpen(false);
    setSearchParams({ chapter: String(next.index) }, { replace: true, state: navigationState });
  }, [bookId, captureChapterAnchor, chapter, chapterPositionKey, usesSimplifiedSource, navigationState, setSearchParams]);
  const { cancel: cancelChapterRefresh, ...chapterRefresh } = useReaderChapterRefresh(bookId, chapter, readerResource, isChapterOutdated, Boolean(pendingResource), setReaderResourceState, applyRefreshedChapter);

  const handleChapterSelect = useCallback(
    (nextChapterIndex: number, requestedScrollRatio?: number, refreshedResource?: Extract<ReaderResourceLoadState['resource'], { chapterCount: number }>) => {
      const navigationResource = refreshedResource ?? chapterResource;
      const navigationCount = navigationResource?.chapterCount ?? chapterCount;
      if (!book || navigationCount <= 0 || pendingResource || chapterEditor.getSnapshot().needsRefresh) {
        return;
      }

      cancelChapterRefresh();
      const normalizedChapterIndex = Math.min(navigationCount, Math.max(1, nextChapterIndex));
      cancelPendingChapterEdit();
      // A scroll save is intentionally delayed to coalesce wheel/touch input.
      // Cancel it before changing chapters so the old closure cannot persist
      // the previous chapter after this navigation has already started.
      if (scrollSaveTimerRef.current) {
        window.clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      // Only loaded, restored text has a reading position. A second selection
      // during a failed/pending load must not save that unseen chapter at 0%.
      if (!refreshedResource && chapter && !isChapterLoading && restoredChapterScrollRef.current && !isNavigatingRef.current
        && canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion)) {
        const scroller = getReaderScrollElement();
        if (scroller && !isRestoringChapterScrollRef.current && !isReaderInteractionBlocked && !isPositionPending()) {
          const visibleRatio = getReaderScrollRatio(scroller);
          if (visibleRatio !== latestChapterScrollRatioRef.current) {
            latestChapterScrollRatioRef.current = visibleRatio;
            hasUserInteractedRef.current = true;
          }
        }
        if (hasUserInteractedRef.current) {
          latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
          const leavingProgress = buildChapterProgress(latestChapterScrollRatioRef.current, effectiveChapterIndex, chapterPositionKey);
          saveChapterPosition(bookId, effectiveChapterIndex, latestChapterScrollRatioRef.current, leavingProgress.updatedAt, chapterPositionKey, captureChapterAnchor());
          updateProgress(leavingProgress);
          void queueReadingProgressSync(bookId, leavingProgress);
        }
      }
      const destinationKey = navigationResource?.toc.find((item) => item.index === normalizedChapterIndex)?.positionKey;
      const storedDestination = readChapterPosition(bookId, normalizedChapterIndex, destinationKey);
      if (normalizedChapterIndex === effectiveChapterIndex && destinationKey && destinationKey !== chapterPositionKey) {
        setChapterState({ bookId, chapter: null, chapterIndex: normalizedChapterIndex, error: null, isLoading: true });
        setChapterRetryKey((key) => key + 1);
      }
      const nextScrollRatio = requestedScrollRatio ?? storedDestination?.ratio ?? 0;
      // Keep navigation intent separate from durable reading progress until
      // the destination text loads and its position is restored successfully.
      pendingChapterNavigationRef.current = {
        bookId, scope: getAccountScope(), chapterIndex: normalizedChapterIndex,
        positionKey: destinationKey, ratio: nextScrollRatio,
        anchor: requestedScrollRatio === undefined ? storedDestination?.anchor : undefined,
      };
      isNavigatingRef.current = true;
      setChapterIndex(normalizedChapterIndex);
      setChapterScrollRatio(nextScrollRatio);
      latestChapterScrollRatioRef.current = nextScrollRatio;
      setHasRestoredChapterScroll(false);
      setChapterScrollRestoreRequest(request => request + 1);
      // Keep ?chapter= in sync (replace, not push) so a refresh restores the
      // chapter being read instead of the one the reader was opened on.
      setSearchParams({ chapter: String(normalizedChapterIndex) }, { replace: true, state: navigationState });
    },
    [book, bookId, buildChapterProgress, cancelChapterRefresh, cancelPendingChapterEdit, canPersistChapterPosition, captureChapterAnchor, chapter, chapterCount, chapterEditor, chapterPositionKey, chapterResource, effectiveChapterIndex, getReaderScrollElement, isChapterLoading, isPositionPending, isReaderInteractionBlocked, pendingResource, navigationState, setSearchParams, updateProgress],
  );

  useEffect(() => {
    if (!canLoadChapter || isChapterLoading || !chapter || restoredChapterScrollRef.current) {
      return;
    }

    const readerElement = getReaderScrollElement();
    if (!readerElement) return;
    // The last pagehide/unmount save is written to local history immediately,
    // while its server PUT may still be in flight (or be deferred by a mobile
    // browser). Startup already resolves those two copies by timestamp; do the
    // same at the moment we actually restore the scroll position. Previously
    // this second stage read only the server CFI and could discard the newer
    // local position, sending a quick reopen back to the chapter beginning.
    const serverProgress = latestReadingProgressRef.current;
    const serverRatio = serverProgress?.chapterIndex === effectiveChapterIndex
      ? decodeChapterScrollRatio(serverProgress.epubCfi)
      : null;
    const localPosition = readChapterPosition(bookId, effectiveChapterIndex, chapterPositionKey);
    const navigation = pendingChapterNavigationRef.current;
    const pendingNavigation = navigation?.bookId === bookId && navigation.scope === getAccountScope()
      && navigation.chapterIndex === effectiveChapterIndex
      && (!navigation.positionKey || navigation.positionKey === chapterPositionKey) ? navigation : null;
    const nextRatio = pendingNavigation?.ratio ?? resolveChapterPosition({
      chapterIndex: effectiveChapterIndex,
      localPosition,
      serverChapterIndex: serverProgress?.chapterIndex,
      serverRatio,
      serverUpdatedAt: serverProgress?.updatedAt,
    });
    const candidateAnchor = pendingNavigation ? pendingNavigation.anchor : resolveChapterAnchor(localPosition, nextRatio, serverProgress ?? undefined, effectiveChapterIndex);
    const savedAnchor = chapterSource ? resolveChapterSourceAnchor(candidateAnchor, chapterSource) : null;
    let stopped = false;
    isRestoringChapterScrollRef.current = true;
    let frame = 0;
    const body = readerShellRef.current?.querySelector<HTMLElement>('.reader-body-text');
    const measureLayout = () => [readerElement.scrollHeight, readerElement.clientWidth, readerElement.clientHeight, body?.offsetWidth, body?.offsetHeight];
    let restoredLayout = measureLayout();
    let restoredTop = readerElement.scrollTop;
    const restoreScroll = () => {
      detectScrollIntent();
      if (stopped || !readerShellRef.current?.isConnected) return;
      readerElement.scrollTop = getScrollTopForRatio(readerElement, nextRatio);
      if (savedAnchor && readerShellRef.current) restoreReaderViewportAnchor(readerShellRef.current, readerElement, savedAnchor);
      pendingChapterEndRef.current = nextRatio === 1;
      const restoredRatio = getReaderScrollRatio(readerElement);
      restoredTop = readerElement.scrollTop;
      restoredLayout = measureLayout();
      latestChapterScrollRatioRef.current = restoredRatio;
      setChapterScrollRatio(restoredRatio);
      setHasRestoredChapterScroll(true);
      isNavigatingRef.current = false;
      if (pendingNavigation && pendingChapterNavigationRef.current === pendingNavigation
        && canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion)) {
        pendingChapterNavigationRef.current = null;
        latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
        hasUserInteractedRef.current = true;
        const progress = buildChapterProgress(restoredRatio, effectiveChapterIndex, chapterPositionKey);
        saveChapterPosition(bookId, effectiveChapterIndex, restoredRatio, progress.updatedAt, chapterPositionKey, captureChapterAnchor());
        updateProgress(progress);
        void queueReadingProgressSync(bookId, progress);
      } else if (canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter.contentVersion)) {
        const pending = getPendingReadingProgress(bookId);
        const pendingTime = pending ? Date.parse(pending.updatedAt) : Number.NaN;
        if (pending?.contentVersion && chapter.contentVersion && pending.contentVersion !== chapter.contentVersion
          && pending.readerType === book?.readerType && pending.chapterIndex === effectiveChapterIndex
          && pending.positionKey === chapterPositionKey && pending.pageNumber === undefined && pending.imageIndex === undefined
          && Number.isFinite(pendingTime) && pendingTime <= getApiServerTime() + 300_000) {
          // The old queued action has now been displayed against current prose.
          // Rebind only this chapter at the recovered viewport, keeping its
          // original reading time so a newer remote action can still win.
          const resumed = { ...buildChapterProgress(restoredRatio, effectiveChapterIndex, chapterPositionKey), updatedAt: pending.updatedAt };
          saveChapterPosition(bookId, effectiveChapterIndex, restoredRatio, resumed.updatedAt, chapterPositionKey, captureChapterAnchor());
          void queueReadingProgressSync(bookId, resumed);
        }
      }
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(restoreScroll);
    };
    const observer = new ResizeObserver(schedule);
    const content = readerShellRef.current?.querySelector('.reader-page-surface');
    if (content) observer.observe(content);
    const gestures = ['pointerdown', 'touchstart', 'wheel', 'keydown', AUDIOBOOK_FOLLOW_EVENT];
    const stop = () => {
      stopped = true;
      isRestoringChapterScrollRef.current = false;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', schedule);
      for (const event of gestures) window.removeEventListener(event, stop);
    };
    const detectScrollIntent = () => {
      // Native scrollbars, accessibility commands and an already-running
      // touch gesture can move the reader without a new DOM input event.
      // Yield only when the restored layout is unchanged: late fonts/images
      // still belong to restoration and must not overwrite the saved place.
      if (stopped || !readerShellRef.current?.isConnected || document.body.style.position === 'fixed') return;
      if (Math.abs(readerElement.scrollTop - restoredTop) <= 1) return;
      const layout = measureLayout();
      if (layout.some((value, index) => value !== restoredLayout[index])) return;
      pendingChapterEndRef.current = false;
      stop();
    };
    detectRestoredScrollIntentRef.current = detectScrollIntent;
    for (const event of gestures) window.addEventListener(event, stop, { passive: true });
    document.fonts?.addEventListener('loadingdone', schedule);
    restoreScroll();
    // Keep late fonts/images at the saved position until reading begins.
    // Their native scroll anchoring must not count as a new reading action.
    return () => {
      if (detectRestoredScrollIntentRef.current === detectScrollIntent) detectRestoredScrollIntentRef.current = null;
      stop();
    };
  }, [book?.readerType, bookId, buildChapterProgress, canLoadChapter, canPersistChapterPosition, captureChapterAnchor, chapter, chapterSource, chapterPositionKey, chapterScrollRestoreRequest, effectiveChapterIndex, getReaderScrollElement, isChapterLoading, updateProgress]);

  useEffect(() => {
    if (!hasRestoredChapterScroll || isChapterLoading || !pendingChapterEndRef.current) return;
    const readerElement = getReaderScrollElement();
    const content = readerShellRef.current?.querySelector('.reader-page-surface');
    if (!readerElement || !content) return;
    let frame = 0;
    const restoreEnd = () => {
      frame = 0;
      if (!pendingChapterEndRef.current) return;
      readerElement.scrollTop = getScrollTopForRatio(readerElement, 1);
      latestChapterScrollRatioRef.current = 1;
      setChapterScrollRatio(1);
    };
    // Fonts and illustrations may finish after the first scroll restoration.
    // Stay at the requested chapter end until a real reading gesture begins.
    const observer = new ResizeObserver(() => {
      if (!frame) frame = window.requestAnimationFrame(restoreEnd);
    });
    observer.observe(content);
    observer.observe(readerElement);
    const stop = () => {
      pendingChapterEndRef.current = false;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown', AUDIOBOOK_FOLLOW_EVENT]) window.removeEventListener(event, stop);
    };
    for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown', AUDIOBOOK_FOLLOW_EVENT]) window.addEventListener(event, stop, { passive: true });
    return stop;
  }, [bookId, chapter, effectiveChapterIndex, getReaderScrollElement, hasRestoredChapterScroll, isChapterLoading]);

  // Detach listeners and flush the last valid position before route teardown
  // removes the text or restores document scrolling for the destination page.
  useLayoutEffect(() => {
    const readerElement = getReaderScrollElement();
    if (!book || !canLoadChapter || !readerElement || isChapterLoading || !hasRestoredChapterScroll) {
      return;
    }

    const saveCurrentScroll = () => {
      scrollSaveTimerRef.current = null;
      if (getAccountScope() !== accountScope || !canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion)) return;
      const finalRatio = latestChapterScrollRatioRef.current;
      setChapterScrollRatio(finalRatio);
      const nextProgress = buildChapterProgress(finalRatio, effectiveChapterIndex, chapterPositionKey);
      saveChapterPosition(bookId, effectiveChapterIndex, finalRatio, nextProgress.updatedAt, chapterPositionKey, captureChapterAnchor());
      updateProgress(nextProgress);
      void queueReadingProgressSync(bookId, nextProgress);
      // Completion should reach the shelf immediately, including a short
      // final chapter that never produced a scroll event.
      if (nextProgress.progressPercent === 100) void flushReadingProgressSync(bookId).catch(() => {});
    };

    const accountScope = getAccountScope();
    let lastStateUpdate = 0;
    let lastRenderedRatio = latestChapterScrollRatioRef.current;
    let lastInteractionRatio = latestChapterScrollRatioRef.current;
    const STATE_UPDATE_THROTTLE_MS = 500;
    let completionRecorded = false;
    let completionFrame = 0;

    const handleScroll = () => {
      if (!readerShellRef.current?.isConnected) return;
      if (getAccountScope() !== accountScope || !canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion) || isBlockingReaderPanelOpen || isPositionPending() || (usesDocumentScroll && document.body.style.position === 'fixed')) return;
      detectRestoredScrollIntentRef.current?.();
      if (isRestoringChapterScrollRef.current || pendingChapterEndRef.current) return;
      const contentEnd = getReaderContentScrollEnd(readerElement);
      const nextRatio = getContentScrollRatio(readerElement.scrollTop, contentEnd);
      // Restores update the ref before their scroll event. For real scrolling,
      // accumulate pixel movement: a chapter-relative per-event threshold can
      // discard every small step of a slow gesture, leaving its timestamp stale.
      if (nextRatio === latestChapterScrollRatioRef.current) lastInteractionRatio = nextRatio;
      if (Math.abs(nextRatio - lastInteractionRatio) * contentEnd >= 1
        || (nextRatio === 1 && latestChapterScrollRatioRef.current !== 1)) {
        lastInteractionRatio = nextRatio;
        hasUserInteractedRef.current = true;
        latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
      }
      latestChapterScrollRatioRef.current = nextRatio;
      if (nextRatio < 1) completionRecorded = false;

      if (nextRatio === 1) {
        if (!completionRecorded) {
          if (scrollSaveTimerRef.current !== null) window.clearTimeout(scrollSaveTimerRef.current);
          completionRecorded = true;
          saveCurrentScroll();
        }
      } else if (scrollSaveTimerRef.current === null) {
        // Keep this deadline while scrolling continues. Waiting for a quiet
        // interval can leave an entire reading session only in memory when a
        // mobile browser discards the page without a final lifecycle event.
        scrollSaveTimerRef.current = window.setTimeout(saveCurrentScroll, 500);
      }

      const now = performance.now();
      if (now - lastStateUpdate >= STATE_UPDATE_THROTTLE_MS && Math.abs(nextRatio - lastRenderedRatio) > 0.001) {
        startTransition(() => {
          setChapterScrollRatio(nextRatio);
        });
        lastRenderedRatio = nextRatio;
        lastStateUpdate = now;
      }
    };

    const checkVisibleCompletion = () => {
      completionFrame = 0;
      if (!readerShellRef.current?.isConnected || completionRecorded || document.visibilityState !== 'visible' || getAccountScope() !== accountScope
        || !canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion) || isBlockingReaderPanelOpen
        || isPositionPending() || isNavigatingRef.current || (usesDocumentScroll && document.body.style.position === 'fixed')) return;
      // Fonts, images and browser chrome can change the endpoint without
      // scrolling. Count only visible body content, never the chapter footer.
      if (document.fonts?.status === 'loading' || [...readerElement.querySelectorAll('img')].some(image => !image.complete)) return;
      if (getReaderScrollRatio(readerElement) !== 1) return;
      completionRecorded = true;
      const currentProgress = latestReadingProgressRef.current;
      if (currentProgress?.bookId === bookId && currentProgress.chapterIndex === effectiveChapterIndex
        && decodeChapterScrollRatio(currentProgress.epubCfi) === 1
        && currentProgress.progressPercent === buildChapterProgress(1, effectiveChapterIndex, chapterPositionKey).progressPercent) return;
      latestChapterScrollRatioRef.current = 1;
      latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
      hasUserInteractedRef.current = true;
      if (scrollSaveTimerRef.current) window.clearTimeout(scrollSaveTimerRef.current);
      saveCurrentScroll();
    };
    const scheduleCompletionCheck = () => {
      if (!completionFrame) completionFrame = window.requestAnimationFrame(checkVisibleCompletion);
    };
    const completionObserver = new ResizeObserver(scheduleCompletionCheck);
    const body = readerElement.querySelector('.reader-body-text');
    if (body) completionObserver.observe(body);
    completionObserver.observe(readerElement);
    readerElement.addEventListener('load', scheduleCompletionCheck, true);
    readerElement.addEventListener('error', scheduleCompletionCheck, true);
    window.visualViewport?.addEventListener('resize', scheduleCompletionCheck);
    document.fonts?.addEventListener('loadingdone', scheduleCompletionCheck);
    scheduleCompletionCheck();

    const captureVisiblePosition = () => {
      // Navigation or backgrounding can overtake the last scroll event. Capture
      // the live coordinate before relying on its ref, and persist it synchronously so
      // a mobile tab can be killed without losing that final reading action.
      // Locked panels and unfinished layout/startup restores still own their
      // coordinates; measuring those would replace valid progress with zero.
      detectRestoredScrollIntentRef.current?.();
      if (readerShellRef.current?.isConnected && readerElement.querySelector('.reader-body-text')
        && !isRestoringChapterScrollRef.current && !isBlockingReaderPanelOpen && !isPositionPending()
        && !isNavigatingRef.current && !pendingChapterEndRef.current
        && !(usesDocumentScroll && document.body.style.position === 'fixed')) {
        const contentEnd = getReaderContentScrollEnd(readerElement);
        const visibleRatio = getContentScrollRatio(readerElement.scrollTop, contentEnd);
        if (Math.abs(visibleRatio - latestChapterScrollRatioRef.current) * contentEnd >= 1) {
          latestChapterScrollRatioRef.current = visibleRatio;
          latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
          hasUserInteractedRef.current = true;
        }
      }
    };

    // Last-chance persistence when the page is being torn down or backgrounded
    // (mobile browsers routinely kill background tabs without unmounting React).
    const flushOnLeave = () => {
      if (getAccountScope() !== accountScope || !canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion)) return;
      captureVisiblePosition();
      if (!hasUserInteractedRef.current) {
        return;
      }
      const leavingProgress = buildChapterProgress(latestChapterScrollRatioRef.current, effectiveChapterIndex, chapterPositionKey);
      saveChapterPosition(bookId, effectiveChapterIndex, latestChapterScrollRatioRef.current, leavingProgress.updatedAt, chapterPositionKey, captureChapterAnchor());
      queueReadingProgressSync(bookId, leavingProgress).catch(() => {});
      flushAllReadingProgressSyncs({ keepalive: true }).catch(() => {});
    };
    const handleLeaveVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushOnLeave();
      } else scheduleCompletionCheck();
    };

    const scrollEventTarget: EventTarget = usesDocumentScroll ? window : readerElement;
    scrollEventTarget.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('pagehide', flushOnLeave);
    document.addEventListener('visibilitychange', handleLeaveVisibilityChange);

    return () => {
      completionObserver.disconnect();
      window.cancelAnimationFrame(completionFrame);
      readerElement.removeEventListener('load', scheduleCompletionCheck, true);
      readerElement.removeEventListener('error', scheduleCompletionCheck, true);
      window.visualViewport?.removeEventListener('resize', scheduleCompletionCheck);
      document.fonts?.removeEventListener('loadingdone', scheduleCompletionCheck);
      scrollEventTarget.removeEventListener('scroll', handleScroll);
      window.removeEventListener('pagehide', flushOnLeave);
      document.removeEventListener('visibilitychange', handleLeaveVisibilityChange);
      if (scrollSaveTimerRef.current) {
        window.clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      if (getAccountScope() !== accountScope || !canPersistChapterPosition(effectiveChapterIndex, chapterPositionKey, chapter?.contentVersion)) return;
      if (isBlockingReaderPanelOpen || isPositionPending() || (usesDocumentScroll && document.body.style.position === 'fixed')) return;
      if (isNavigatingRef.current) {
        // The leaving position was captured before navigation. Wait for the
        // destination text before allowing its coordinates to be persisted.
        return;
      }
      // SPA back/forward does not fire pagehide. Read the still-mounted text
      // before the destination page resets document scrolling, even if its
      // last scroll event or debounced save never ran.
      captureVisiblePosition();
      if (!hasUserInteractedRef.current) {
        // This session never actually read anything — writing progress here
        // would let a stale tab clobber progress made on another device.
        return;
      }
      const leavingProgress = buildChapterProgress(latestChapterScrollRatioRef.current, effectiveChapterIndex, chapterPositionKey);
      saveChapterPosition(bookId, effectiveChapterIndex, latestChapterScrollRatioRef.current, leavingProgress.updatedAt, chapterPositionKey, captureChapterAnchor());
      void queueReadingProgressSync(bookId, leavingProgress)
        .then(() => flushReadingProgressSync(bookId))
        .catch(() => {
          // ProgressSyncIndicator exposes the pending/retry state without
          // interrupting the reading surface.
        });
    };
  }, [book, bookId, buildChapterProgress, canLoadChapter, canPersistChapterPosition, captureChapterAnchor, chapter?.contentVersion, chapterPositionKey, effectiveChapterIndex, getReaderScrollElement, hasRestoredChapterScroll, isChapterLoading, isPositionPending, isReaderInteractionBlocked, isBlockingReaderPanelOpen, updateProgress, usesDocumentScroll]);

  const handleChapterStep = useCallback(
    (delta: number) => {
      const nextChapterIndex = effectiveChapterIndex + delta;
      // At either boundary a step must be a no-op — clamping it back to the
      // same chapter would scroll to its top and overwrite progress with 0%.
      if (nextChapterIndex < 1 || nextChapterIndex > safeChapterCount) {
        return;
      }
      // Sequential navigation joins adjacent chapter boundaries. Resuming a
      // chapter's saved position belongs to an explicit catalogue selection.
      handleChapterSelect(nextChapterIndex, delta < 0 ? 1 : 0);
    },
    [effectiveChapterIndex, handleChapterSelect, safeChapterCount],
  );

  const handlePagedNextBoundary = useCallback(() => {
    handleChapterStep(1);
  }, [handleChapterStep]);
  const handlePagedPreviousBoundary = useCallback(() => {
    if (effectiveChapterIndex > 1) {
      handleChapterSelect(effectiveChapterIndex - 1, 1);
    }
  }, [effectiveChapterIndex, handleChapterSelect]);
  const pagedReading = usePagedReading({
    containerRef: readerShellRef,
    contentKey: `${bookId}:${effectiveChapterIndex}:${JSON.stringify(readerPreferences)}`,
    enabled: isPagedMode && hasRestoredChapterScroll && !isChapterLoading && !chapterError && !isReaderInteractionBlocked,
    onNextBoundary: handlePagedNextBoundary,
    onPreviousBoundary: handlePagedPreviousBoundary,
  });
  const { goToNextPage, goToPreviousPage } = pagedReading;
  const isReaderNavigationBusy = isChapterLoading || Boolean(chapterError) || isReaderInteractionBlocked || !hasRestoredChapterScroll;
  const isPagedPreviousDisabled = isReaderNavigationBusy || (effectiveChapterIndex <= 1 && pagedReading.isAtStart);
  const isPagedNextDisabled = isReaderNavigationBusy || (effectiveChapterIndex >= safeChapterCount && pagedReading.isAtEnd);

  // Paged semantics: page within the chapter first, cross the chapter
  // boundary when the current one runs out. Paging back into the previous
  // chapter lands on its end (ratio 1), matching every mainstream reader.
  const handleReadForward = useCallback(() => {
    if (isReaderNavigationBusy) return;
    if (isPagedMode && goToNextPage()) {
      hasUserInteractedRef.current = true;
      latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
      return;
    }
    if (isPagedMode) onRestoreLayoutPosition(1);
    handleChapterStep(1);
  }, [bookId, goToNextPage, handleChapterStep, isPagedMode, isReaderNavigationBusy, onRestoreLayoutPosition]);

  const handleReadBackward = useCallback(() => {
    if (isReaderNavigationBusy) return;
    if (isPagedMode) {
      if (goToPreviousPage()) {
        hasUserInteractedRef.current = true;
        latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
        return;
      }
      if (effectiveChapterIndex > 1) {
        handleChapterSelect(effectiveChapterIndex - 1, 1);
      }
      return;
    }
    handleChapterStep(-1);
  }, [bookId, effectiveChapterIndex, goToPreviousPage, handleChapterSelect, handleChapterStep, isPagedMode, isReaderNavigationBusy]);

  const touchPageTurnsRef = useRef<Array<{ from: number; to: number; layout: string }>>([]);
  useEffect(() => { touchPageTurnsRef.current = []; }, [bookId, chapter, readerPreferences]);

  const handleTouchPageStep = useCallback((direction: 1 | -1) => {
    if (!canLoadChapter || !chapter || isChapterLoading || !hasRestoredChapterScroll || isReaderInteractionBlocked) return;
    if (isPagedMode) {
      if (direction > 0) handleReadForward();
      else handleReadBackward();
      return;
    }
    const element = getReaderScrollElement();
    if (!element) return;
    const maxScrollTop = getReaderContentScrollEnd(element);
    const currentTop = Math.max(0, Math.min(element.scrollTop, maxScrollTop));
    if (direction > 0 && currentTop >= maxScrollTop - 1) {
      onRestoreLayoutPosition(1);
      if (effectiveChapterIndex < safeChapterCount) handleChapterSelect(effectiveChapterIndex + 1, 0);
      return;
    }
    if (direction < 0 && currentTop <= 1) {
      if (effectiveChapterIndex > 1) handleChapterSelect(effectiveChapterIndex - 1, 1);
      return;
    }
    const chromeStyle = readerRootRef.current?.style;
    const chromeHeight = (Number.parseFloat(chromeStyle?.getPropertyValue('--reader-layout-top-inset') ?? '') || 0)
      + (Number.parseFloat(chromeStyle?.getPropertyValue('--reader-layout-bottom-inset') ?? '') || 0);
    const viewportHeight = usesDocumentScroll
      ? Math.max(1, (window.visualViewport?.height ?? window.innerHeight) - chromeHeight)
      : element.clientHeight;
    // Keep two lines in view for continuity. Discrete steps also make rapid
    // taps predictable without an in-flight animation crossing a chapter.
    const body = element.querySelector('.reader-body-text');
    const lineHeight = body ? Number.parseFloat(getComputedStyle(body).lineHeight) : 32;
    const overlap = Math.max(64, (Number.isFinite(lineHeight) ? lineHeight : 32) * 2);
    const pageStep = Math.max(viewportHeight - overlap, 1);
    const layout = `${element.clientWidth}:${viewportHeight}:${element.scrollHeight}:${maxScrollTop}:${pageStep}`;
    const previous = touchPageTurnsRef.current.at(-1);
    const canReverse = previous && previous.layout === layout && Math.abs(previous.to - currentTop) <= 1;
    if (!canReverse) touchPageTurnsRef.current = [];
    if (direction < 0 && canReverse) {
      element.scrollTop = previous.from;
      touchPageTurnsRef.current.pop();
    } else {
      element.scrollTop = Math.max(0, Math.min(maxScrollTop, currentTop + direction * pageStep));
      if (direction > 0) {
        // The final step can be shorter than a screen. Reversing it must
        // return to the text just left, not jump back a whole extra screen.
        touchPageTurnsRef.current.push({ from: currentTop, to: element.scrollTop, layout });
        if (touchPageTurnsRef.current.length > 120) touchPageTurnsRef.current.shift();
      }
    }
  }, [canLoadChapter, chapter, effectiveChapterIndex, getReaderScrollElement, handleChapterSelect, handleReadBackward, handleReadForward, hasRestoredChapterScroll, isChapterLoading, isPagedMode, isReaderInteractionBlocked, onRestoreLayoutPosition, safeChapterCount, usesDocumentScroll]);
  const handleTouchForward = useCallback(() => handleTouchPageStep(1), [handleTouchPageStep]);
  const handleTouchBackward = useCallback(() => handleTouchPageStep(-1), [handleTouchPageStep]);

  const handleReaderTouchTap = useCallback(({ clientX }: { clientX: number }) => {
    if (isReaderInteractionBlocked || isChapterLoading || !chapter) return;
    const rect = readerShellRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left;
    if (readerPreferences.tapToTurnPage && (x < rect.width * 0.28 || x > rect.width * 0.72)) {
      controls.hideControls();
      if (x < rect.width * 0.28) handleTouchBackward();
      else handleTouchForward();
    } else controls.toggleControls();
  }, [chapter, controls, handleTouchBackward, handleTouchForward, isChapterLoading, isReaderInteractionBlocked, readerPreferences.tapToTurnPage]);

  const { isTouchClick, shouldIgnoreClick } = useReaderTouchGestures({
    allowRubyEdgePageTurns: readerPreferences.tapToTurnPage,
    enabled: Boolean(canLoadChapter && chapter && !isChapterLoading && !isReaderInteractionBlocked),
    onSwipeLeft: handleTouchForward,
    onSwipeRight: handleTouchBackward,
    onTap: handleReaderTouchTap,
    targetRef: readerShellRef,
  });

  const captureSelectedReaderText = useCallback(() => {
    const selection = window.getSelection();
    const shell = readerShellRef.current;
    if (!selection || !selection.rangeCount || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
      || !shell?.contains(selection.anchorNode) || !shell.contains(selection.focusNode)) {
      setSelectedReaderText('');
      return;
    }
    // Notes may intentionally quote the displayed translation. Ruby readings
    // are presentation aids and must never become part of the quoted text.
    const selectedText = isJapanese
      ? getJapaneseSelectionText(selection.getRangeAt(0), { includeTranslations: true })
      : selection.toString().trim();
    setSelectedReaderText(selectedText.slice(0, 1000));
  }, [isJapanese]);

  const handleOpenMarks = useCallback(() => {
    cancelPendingChapterEdit();
    captureSelectedReaderText();
    // Displayed progress is throttled. Capture the visible position before
    // the panel locks document scrolling, so a quick bookmark stays accurate.
    const readerElement = getReaderScrollElement();
    if (!isBlockingReaderPanelOpen && chapter && !isChapterLoading && hasRestoredChapterScroll && readerElement) {
      const contentEnd = getReaderContentScrollEnd(readerElement);
      const ratio = getContentScrollRatio(readerElement.scrollTop, contentEnd);
      // A click can arrive before the last scroll event. Keep its timestamp
      // with the captured coordinate so the server accepts the newer position.
      if (Math.abs(ratio - latestChapterScrollRatioRef.current) * contentEnd >= 1) {
        latestProgressUpdatedAtRef.current = createReadingProgressTimestamp(latestProgressUpdatedAtRef.current, bookId);
        hasUserInteractedRef.current = true;
      }
      latestChapterScrollRatioRef.current = ratio;
      setChapterScrollRatio(ratio);
    }
    setIsMarksOpen(true);
  }, [bookId, cancelPendingChapterEdit, captureSelectedReaderText, chapter, getReaderScrollElement, hasRestoredChapterScroll, isBlockingReaderPanelOpen, isChapterLoading]);

  const handleOpenChapterEdit = useCallback(() => {
    if (!book || chapterEditState.isLoading || chapterEditState.isSaving) return;
    controls.showControls();
    void chapterEditor.open(effectiveChapterIndex);
  }, [book, chapterEditState.isLoading, chapterEditState.isSaving, chapterEditor, controls, effectiveChapterIndex]);

  const handleSaveChapterEdit = useCallback((input: Parameters<typeof updateBookChapter>[2], revision: string) => {
    const editableChapter = chapterEditState.chapter;
    if (!book || !editableChapter || chapterEditState.isSaving) return false;
    const readingAnchor = captureChapterAnchor();
    const readingRatio = latestChapterScrollRatioRef.current;
    return chapterEditor.save(input, (refreshedChapter, refreshedResource) => {
      const anchor = rebaseEditedChapterAnchor(readingAnchor, chapter, refreshedChapter, usesSimplifiedSource);
      pendingChapterNavigationRef.current = {
        bookId: book.id, scope: getAccountScope(), chapterIndex: editableChapter.index,
        positionKey: refreshedChapter.positionKey, ratio: readingRatio, anchor,
      };
      isNavigatingRef.current = true;
      setHasRestoredChapterScroll(false);
      setChapterScrollRestoreRequest(request => request + 1);
      setChapterState({
        bookId: book.id,
        chapter: refreshedChapter,
        chapterIndex: editableChapter.index,
        error: null,
        isLoading: false,
      });
      setReaderResourceState({ bookId: book.id, isLoaded: true, resource: refreshedResource });
    }, revision);
  }, [book, captureChapterAnchor, chapter, usesSimplifiedSource, chapterEditState.chapter, chapterEditState.isSaving, chapterEditor]);

  const handleDeleteChapter = useCallback(() => {
    if (!book || !chapterEditState.chapter || chapterEditState.isSaving) return false;
    return chapterEditor.remove((refreshedResource, nextIndex, ratio) => {
      setReaderResourceState({ bookId: book.id, isLoaded: true, resource: refreshedResource });
      setChapterState({ bookId: book.id, chapter: null, chapterIndex: nextIndex, error: null, isLoading: true });
      setChapterRetryKey((key) => key + 1);
      if ('chapterCount' in refreshedResource) handleChapterSelect(nextIndex, ratio, refreshedResource);
    });
  }, [book, chapterEditState.chapter, chapterEditState.isSaving, chapterEditor, handleChapterSelect]);

  const handleFindNext = useCallback(() => {
    setActiveFindMatchIndex((currentIndex) => (findMatchCount ? (currentIndex + 1) % findMatchCount : 0));
  }, [findMatchCount]);

  const handleFindPrevious = useCallback(() => {
    setActiveFindMatchIndex((currentIndex) => (findMatchCount ? (currentIndex - 1 + findMatchCount) % findMatchCount : 0));
  }, [findMatchCount]);

  const handleReaderShellClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const touchClick = isTouchClick(event.nativeEvent);
      const edgeTap = touchClick && readerPreferences.tapToTurnPage && isReaderEdgePageTarget(event.target, event.clientX, event.currentTarget);
      if (isReaderInteractionBlocked || isChapterLoading || !chapter || shouldIgnoreClick() || (isReaderInteractiveTarget(event.target) && !edgeTap) || window.getSelection()?.toString().trim()) {
        return;
      }

      if (!touchClick || !readerPreferences.tapToTurnPage) {
        controls.toggleControls();
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      // Touch zones work in both reading modes, including landscape tablets.
      if (clickX < rect.width * 0.28) {
        controls.hideControls();
        handleTouchBackward();
        return;
      }
      if (clickX > rect.width * 0.72) {
        controls.hideControls();
        handleTouchForward();
        return;
      }

      controls.toggleControls();
    },
    [chapter, controls, handleTouchBackward, handleTouchForward, isChapterLoading, isReaderInteractionBlocked, isTouchClick, readerPreferences.tapToTurnPage, shouldIgnoreClick],
  );

  useReaderChromeLayout({
    contentKey: `${bookId}:${effectiveChapterIndex}:${Boolean(chapter)}`,
    enabled: canLoadChapter,
    hasAudiobook: isAudiobookOpen,
    isTopDocked: hasDesktopPointer && !isPagedMode,
    rootRef: readerRootRef,
    shellRef: readerShellRef,
    usesDocumentScroll,
  });

  useReaderKeyboardShortcuts({
    disabled: isReaderNavigationBusy,
    onArrowLeft: isPagedMode ? handleReadBackward : () => handleChapterStep(-1),
    onArrowRight: isPagedMode ? handleReadForward : () => handleChapterStep(1),
    onPageDown: isPagedMode ? handleReadForward : undefined,
    onPageUp: isPagedMode ? handleReadBackward : undefined,
  });

  const resolveMarkPosition = useCallback(
    (input: ReaderMarkCreateInput) => {
      if (pendingResource) throw new Error('阅读文件已更新，请先打开新版；备注草稿已保留。');
      if (input.readerType !== book?.readerType) throw new Error('草稿来自旧格式，请改存到当前位置。');
      if (book?.readerType === 'pdf') {
        if (input.positionKey && input.positionKey !== pdfResource?.positionKey) throw new Error('草稿来自旧文件，请改存到当前位置。');
        return input;
      }
      if (isChapterOutdated) throw new Error('本话已更新，请先加载新版正文；备注草稿已保留。');
      if (input.positionKey) {
        const destination = toc.find((item) => item.positionKey === input.positionKey);
        if (!destination) throw new Error('草稿所属章节已被替换或删除，请改存到当前位置。');
        if (destination.contentVersion && input.contentVersion !== destination.contentVersion) throw new Error('草稿来自更新前的正文，请核对后改存到当前位置。');
        const ratio = decodeChapterScrollRatio(input.epubCfi) ?? 0;
        return { ...input, chapterIndex: destination.index, progressPercent: getChapterProgressPercent(destination.index, safeChapterCount, ratio, chapterProgressWeights) };
      }
      return input;
    },
    [book?.readerType, chapterProgressWeights, isChapterOutdated, pdfResource?.positionKey, pendingResource, safeChapterCount, toc],
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
      if (pendingResource || isChapterOutdated) return false;
      const target = resolveReaderMarkTarget(mark, readerMarkResource);
      if (target?.kind === 'pdf') {
        setPdfPageRequest({ bookId, pageNumber: target.pageNumber });
        return true;
      }
      if (target?.kind === 'chapter') {
        handleChapterSelect(target.index, target.ratio);
        return true;
      }
      return false;
    },
    [bookId, handleChapterSelect, isChapterOutdated, pendingResource, readerMarkResource],
  );

  if (!book || book.id !== bookId) {
    if (startupError) {
      return <ReaderStartupState bookId={bookId} message={startupError.message} onRetry={() => { setStartupError(null); setStartupRetryKey((key) => key + 1); }} status={startupError.status} theme={theme} />;
    }
    return <ReaderStartupState bookId={bookId} status="loading" theme={theme} />;
  }

  if (chapterEditState.needsRefresh) {
    return <ReaderMutationRecovery bookId={bookId} message={chapterEditState.message} onReload={reloadEdition} theme={theme} />;
  }

  const readerMarksProps = {
    resource: readerMarkResource,
    editionSwitch,
    chapterRefresh: isChapterOutdated && !pendingResource ? chapterRefresh : undefined,
    bookId, isOpen: isMarksOpen, deletingIds: marksState.deletingIds, relocatingIds: marksState.relocatingIds, error: marksState.error,
    hasLoaded: marksState.hasLoaded, isLoading: marksState.isLoading, loadError: marksState.loadError,
    onReload: () => void marksController.load(), isDark: isDarkTheme, theme, isSaving: marksState.isSaving, marks: marksState.marks,
    onClose: () => setIsMarksOpen(false), onCreateMark: handleCreateMark, onDeleteMark: handleDeleteMark, onSelectMark: handleSelectMark, onRelocateMark: handleRelocateMark,
  };
  const readerAvailability = getBrowserReaderAvailability(book, readerResource);
  if (!readerAvailability.canReadInBrowser && (book.readerType === 'pdf' || isReaderResourceLoaded)) {
    return (
      <UnsupportedReaderState
        book={book}
        downloadError={download.error}
        isDownloadPreparing={download.isPreparing}
        isDownloadDisabled={!book.fileSize}
        message={readerAvailability.reason ?? '当前文件已保存在私有书库，可先下载原文件阅读。'}
        onDownload={() => void download.run(book)}
        theme={theme}
      />
    );
  }

  if (book.readerType === 'pdf' && readerAvailability.canReadInBrowser) {
    if (!pdfPreviewUrl) {
      return <ReaderStartupState bookId={bookId} status="loading" theme={theme} />;
    }
    return (
      <><Suspense fallback={<ReaderStartupState bookId={bookId} status="loading" theme={theme} />}>
        <PdfReader
          key={`${book.id}:${session?.id ?? ''}:${pdfResource?.positionKey ?? ''}`}
          bookId={bookId}
          statusContent={<ProgressSyncIndicator bookId={bookId} inline actionable inverted />}
          progressPercent={savedProgressPercent}
          editionSwitch={editionSwitch}
          onCheckUpdate={contentCheck.onRetry}
          isOverlayOpen={isMarksOpen}
          onOpenMarks={() => setIsMarksOpen(true)}
          pageRequest={pdfPageRequest?.bookId === bookId ? pdfPageRequest : undefined}
          downloadDisabled={!book.fileSize}
          downloadError={download.error}
          isDownloadPreparing={download.isPreparing}
          initialPage={pdfInitialPage}
          onBack={() => {
            flushPdfProgress();
            navigate(getBookDetailPath(book.id), { state: createCollectionLinkState(location) });
          }}
          onDownload={() => void download.run(book)}
          onLeave={flushPdfProgress}
          onPageChange={handlePdfPageChange}
          onPageCountChange={handlePdfPageCountChange}
          onPreferencesChange={setReaderPreferences}
          preferences={readerPreferences}
          refreshUrl={refreshPdfUrl}
          title={book.title}
          url={pdfPreviewUrl}
        />
      </Suspense><ReaderMarksPanel {...readerMarksProps} currentMarkInput={{ positionKey: pdfResource?.positionKey, kind: 'bookmark', label: `第 ${pdfInitialPage} 页`, pageNumber: pdfInitialPage, progressPercent: savedProgressPercent, readerType: 'pdf' }} /></>
    );
  }

  const currentChapterTitle = chapter?.title ?? toc.find((item) => item.index === effectiveChapterIndex)?.title ?? book.currentChapter ?? `第 ${effectiveChapterIndex} 章`;
  const savedChapter = !pendingResource && readingProgress.progress?.chapterIndex
    ? toc.find((item) => item.index === readingProgress.progress?.chapterIndex
      && (!readingProgress.progress.positionKey || item.positionKey === readingProgress.progress.positionKey)) : undefined;
  const usesSimplifiedDisplay = chineseScript === 'simplified';
  const displayBookTitle = usesSimplifiedDisplay ? convertTraditionalToSimplified(book.title) : book.title;
  const displayChapterTitle = usesSimplifiedDisplay ? convertTraditionalToSimplified(currentChapterTitle) : currentChapterTitle;
  const displayBook = displayBookTitle === book.title ? book : { ...book, title: displayBookTitle };
  const chapterNavigationProps = {
    chapterIndex: effectiveChapterIndex,
    chapterCount: safeChapterCount,
    disabled: isChapterLoading || Boolean(chapterError) || isBlockingReaderPanelOpen || isFindOpen,
    previousTitle: displayToc.find((item) => item.index === effectiveChapterIndex - 1)?.title,
    nextTitle: displayToc.find((item) => item.index === effectiveChapterIndex + 1)?.title,
    onNext: () => handleChapterStep(1),
    onPrevious: () => handleChapterStep(-1),
  };
  const currentMarkInput: ReaderMarkCreateInput = {
    contentVersion: chapter?.contentVersion,
    positionKey: chapterPositionKey,
    chapterIndex: effectiveChapterIndex,
    epubCfi: encodeChapterScrollRatio(chapterScrollRatio),
    kind: 'bookmark',
    label: currentChapterTitle,
    note: selectedReaderText ? `摘录：${selectedReaderText}` : undefined,
    progressPercent,
    readerType: book.readerType,
  };

  return (
    <div className={cn(`reader-with-reading-status reader-theme-${theme}`, isTocDocked && 'reader-has-docked-toc')} ref={readerRootRef}>
      <div className="relative z-[70]" onClick={(event) => event.stopPropagation()} onPointerDown={controls.showControls}>
        <ReaderTopBar
          book={displayBook}
          chapterTitle={displayChapterTitle}
          contentCheck={contentCheck}
          editionSwitch={editionSwitch}
          isDark={isDarkTheme}
          isEditLoading={chapterEditState.isLoading}
          isVisible={isTopReaderControlsVisible}
          isDocked={hasDesktopPointer && !isPagedMode}
          isCatalogOpen={isTocOpen}
          onOpenToc={handleOpenToc}
          onOpenSettings={handleOpenSettings}
          onEditChapter={chapter && !isChapterLoading && !pendingResource && !isChapterOutdated && book.isOwned !== false && (book.readerType === 'epub' || (book.readerType === 'text' && book.fileExt?.toLowerCase() === '.txt')) ? handleOpenChapterEdit : undefined}
          chapterRefresh={isChapterOutdated && !pendingResource ? chapterRefresh : undefined}
        />
      </div>
      <main
        ref={readerShellRef}
        className={`reader-paper-shell reader-theme-${theme} reader-viewport z-40 overflow-x-hidden transition-colors duration-500 reader-scrollbar ${usesDocumentScroll ? 'reader-document-scroll' : 'fixed inset-0'} ${isPagedMode && !chapterError ? 'reader-paged-mode overflow-y-hidden' : usesDocumentScroll ? 'reader-scroll-mode' : 'reader-scroll-mode overflow-y-auto'} ${readerThemeClass[theme]}`}
        onClick={handleReaderShellClick}
      >
      <div className="relative z-0">
        {chapterError ? (
          <section aria-labelledby="reader-chapter-error-title" className="reader-chapter-error mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-24 text-[color:var(--reader-ink)]" onClick={(event) => event.stopPropagation()} role="alert">
            <h2 className="font-display text-xl font-semibold" id="reader-chapter-error-title">本章加载失败</h2>
            <p className="reader-muted mt-3 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{chapterError}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                icon={<RefreshCcw className="h-4 w-4" />}
                onClick={() => {
                  preloadedChapterRef.current = null;
                  setChapterState({ bookId, chapter: null, chapterIndex: effectiveChapterIndex, error: null, isLoading: true });
                  setChapterRetryKey((key) => key + 1);
                }}
              >
                重试本章
              </Button>
              {savedChapter && savedChapter.index !== effectiveChapterIndex && (
                <button className="min-h-11 rounded-2xl bg-[color:var(--reader-hairline)] px-4 text-sm transition hover:text-[color:var(--reader-accent)]" onClick={() => handleChapterSelect(savedChapter.index)} type="button">
                  返回上次阅读
                </button>
              )}
            </div>
            <button className="reader-muted mt-3 min-h-11 w-fit text-sm underline decoration-current/40 underline-offset-4 hover:text-[color:var(--reader-accent)]" onClick={() => navigate(getBookDetailPath(book.id), { state: navigationState })} type="button">返回图书详情</button>
          </section>
        ) : (
          <NovelContent
            activeAudiobookParagraphIndex={audiobookCue?.chapterIndex === effectiveChapterIndex ? audiobookCue.paragraphIndex ?? undefined : undefined}
            activeSearchMatchIndex={activeFindMatchIndex}
            bodyFontClassName={readerBodyFontClass[readerPreferences.fontFamily]}
            bookId={book.id}
            blocks={chapter?.blocks}
            chapterStartNavigation={!isTouchReader && !isPagedMode && chapter && effectiveChapterIndex > 1 ? <ReaderChapterNavigation {...chapterNavigationProps} placement="start" /> : undefined}
            chapterNavigation={!isTouchReader && !isPagedMode && chapter ? <ReaderChapterNavigation {...chapterNavigationProps} /> : undefined}
            chapterTitle={displayChapterTitle}
            chineseScript={chineseScript}
            key={`${book.id}-${effectiveChapterIndex}`}
            content={chapter?.content ?? ''}
            contentWidthClassName={readerContentWidthClass[readerPreferences.contentWidth]}
            fontClassName={readerFontClass[readerPreferences.fontScale]}
            fontWeightClassName={readerFontWeightClass[readerPreferences.fontWeight]}
            followAudiobookText={audiobookCue?.chapterIndex === effectiveChapterIndex && audiobookCue.followText && !isPagedMode && !isReaderInteractionBlocked}
            isLoading={isChapterLoading}
            language={book.language}
            japaneseFuriganaMode={japaneseFuriganaMode}
            japaneseLayout={readerPreferences.japaneseLayout}
            japaneseTranslationMode={japaneseTranslationMode}
            lineHeightClassName={readerLineHeightClass[readerPreferences.lineHeight]}
            pagePaddingClassName={readerPagePaddingClass[readerPreferences.pagePadding]}
            paragraphSpacingClassName={readerParagraphSpacingClass[readerPreferences.paragraphSpacing]}
            readerTheme={theme}
            selectionAssistantDisabled={isBlockingReaderPanelOpen || isFindOpen}
            searchQuery={isFindOpen ? findQuery : ''}
            onSearchMatchCountChange={setFindMatchCount}
            textAlign={readerPreferences.textAlign}
            textIndentClassName={readerTextIndentClass[readerPreferences.textIndent]}
            title={displayBookTitle}
          />
        )}
      </div>
      </main>
      {!isPagedMode && !hasCoarsePointer && <ReaderScrollPosition contentKey={`${bookId}-${effectiveChapterIndex}-${Boolean(chapter)}`} getScrollElement={getReaderScrollElement} onDragStateChange={setIsScrollPositionDragging} usesDocumentScroll={usesDocumentScroll} />}
      <ReaderReadingStatus bookId={bookId} isHidden={controls.isControlsVisible || isBlockingReaderPanelOpen || isFindOpen} progressPercent={progressPercent} theme={theme} />
      {isPagedMode && hasDesktopPointer && (
        <div className="pointer-events-none fixed inset-y-0 left-0 right-0 z-[60] hidden items-center justify-between px-3 md:flex lg:px-6">
          <button
            aria-label="上一页"
            className="reader-page-turn pointer-events-auto grid h-24 w-12 place-items-center rounded-2xl border border-current/10 bg-current/[0.035] text-current/45 backdrop-blur-md transition duration-300 hover:-translate-x-0.5 hover:bg-current/[0.08] hover:text-current disabled:pointer-events-none disabled:opacity-0"
            disabled={isPagedPreviousDisabled}
            onClick={(event) => {
              event.stopPropagation();
              handleReadBackward();
            }}
            type="button"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            aria-label="下一页"
            className="reader-page-turn pointer-events-auto grid h-24 w-12 place-items-center rounded-2xl border border-current/10 bg-current/[0.035] text-current/45 backdrop-blur-md transition duration-300 hover:translate-x-0.5 hover:bg-current/[0.08] hover:text-current disabled:pointer-events-none disabled:opacity-0"
            disabled={isPagedNextDisabled}
            onClick={(event) => {
              event.stopPropagation();
              handleReadForward();
            }}
            type="button"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </div>
      )}
      <div className="relative z-[70]" onClick={(event) => event.stopPropagation()} onPointerDown={controls.showControls}>
        <ReaderBottomBar
          hidePageNavigation={isTouchReader}
          chapterCount={safeChapterCount}
          chineseScript={chineseScript}
          currentChapterIndex={effectiveChapterIndex}
          currentPage={isPagedMode ? pagedReading.currentPage : undefined}
          isDark={isDarkTheme}
          isNextDisabled={isPagedMode ? isPagedNextDisabled : isReaderNavigationBusy || effectiveChapterIndex >= safeChapterCount}
          isPreviousDisabled={isPagedMode ? isPagedPreviousDisabled : isReaderNavigationBusy || effectiveChapterIndex <= 1}
          isVisible={controls.isControlsVisible}
          onNext={isPagedMode ? handleReadForward : () => handleChapterStep(1)}
          onOpenFind={() => {
            cancelPendingChapterEdit();
            controls.showControls();
            setIsFindOpen(true);
          }}
          onOpenMarks={handleOpenMarks}
          onOpenSettings={handleOpenSettings}
          onOpenJapaneseTools={isJapanese ? () => {
            cancelPendingChapterEdit();
            preservePosition();
            controls.showControls();
            setIsJapaneseToolsOpen(true);
          } : undefined}
          onOpenAudiobook={() => {
            controls.showControls();
            setIsAudiobookOpen(true);
            setAudiobookPlayRequest((current) => ({ chapterIndex: effectiveChapterIndex, id: current.id + 1 }));
          }}
          onPrevious={isPagedMode ? handleReadBackward : () => handleChapterStep(-1)}
          onToggleChineseScript={isChinese ? () => {
            changeReaderPreferences({ ...readerPreferences, chineseScript: readerPreferences.chineseScript === 'simplified' ? 'original' : 'simplified' });
          } : undefined}
          pageCount={isPagedMode ? pagedReading.pageCount : undefined}
          progressPercent={progressPercent}
          readingMetaLabel={readingMetaLabel}
          theme={theme}
        />
      </div>
      <AudiobookPlayer
        bookId={book.id}
        bookTitle={displayBookTitle}
        chapterCount={safeChapterCount}
        chineseScript={chineseScript}
        isControlsVisible={controls.isControlsVisible}
        isOpen={isAudiobookOpen}
        onChapterComplete={handleAudiobookChapterComplete}
        onClose={() => {
          setAudiobookCue(null);
          setIsAudiobookOpen(false);
        }}
        onCueChange={(change) => setAudiobookCue(change.paragraphIndex === null ? null : change)}
        onSelectChapter={handleChapterSelect}
        playRequest={audiobookPlayRequest}
        theme={theme}
        toc={displayToc}
      />
      {isFindOpen && (
        <ReaderFindBar
          activeMatchIndex={activeFindMatchIndex}
          isDark={isDarkTheme}
          matchCount={findMatchCount}
          theme={theme}
          onChangeQuery={(query) => {
            setFindQuery(query);
            setActiveFindMatchIndex(0);
          }}
          onClose={() => {
            setIsFindOpen(false);
            setFindQuery('');
            setActiveFindMatchIndex(0);
          }}
          onNext={handleFindNext}
          onPrevious={handleFindPrevious}
          query={findQuery}
        />
      )}
      <EditChapterDialog
        key={bookId}
        bookId={bookId}
        chapter={chapterEditState.chapter}
        errorMessage={chapterEditState.error ?? undefined}
        hasImages={chapterEditState.chapter?.hasImages}
        isSaving={chapterEditState.isSaving}
        readerTheme={theme}
        onCancel={() => {
          if (chapterEditState.isSaving) return;
          chapterEditor.close();
        }}
        onDelete={handleDeleteChapter}
        onDiscardDraft={chapterEditor.clearError}
        onSave={handleSaveChapterEdit}
      />
      {chapterEditState.message && (
        <div className="reader-inline-message reader-toast-safe fixed left-1/2 z-[90] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md px-4 py-2 text-center text-xs" role="status">
          {chapterEditState.message}
        </div>
      )}
      {isTocOpen && (
        <ReaderTocPanel
          bookId={book.id}
          bookTitle={displayBookTitle}
          author={book.author}
          isDocked={isTocDocked}
          currentChapterIndex={effectiveChapterIndex}
          currentChapterTitle={displayChapterTitle}
          theme={theme}
          isDark={isDarkTheme}
          onClose={handleCloseToc}
          onSelectChapter={handleChapterSelect}
          toc={displayToc}
        />
      )}
      <ReaderMarksPanel
        {...readerMarksProps}
        currentMarkInput={currentMarkInput}
      />
      {isSettingsOpen && (
        <ReaderSettingsPanel
          isDark={isDarkTheme}
          onChange={changeReaderPreferences}
          onClose={() => { setIsSettingsOpen(false); controls.hideControls(); }}
          preferences={readerPreferences}
          showChineseScript={isChinese}
        />
      )}
      {isJapanese && isJapaneseToolsOpen && (
        <JapaneseReaderToolsPanel
          furiganaMode={japaneseFuriganaMode}
          theme={theme}
          layout={readerPreferences.japaneseLayout}
          onChangeFurigana={(mode) => {
            preservePosition();
            setJapaneseFuriganaMode(mode);
            saveJapaneseFuriganaMode(book.id, mode);
          }}
          onChangeLayout={(layout) => {
            saveJapaneseLayout(book.id, layout);
            changeReaderPreferences({ ...readerPreferences, japaneseLayout: layout });
          }}
          onChangeTranslation={(mode) => {
            preservePosition();
            setJapaneseTranslationMode(mode);
            saveJapaneseTranslationMode(book.id, mode);
          }}
          onClose={() => setIsJapaneseToolsOpen(false)}
          translationMode={japaneseTranslationMode}
        />
      )}
    </div>
  );
}

function prefetchUpcomingChapters(bookId: string, currentChapterIndex: number, chapterCount: number): Promise<void> {
  const prefetchCount = Math.min(CHAPTER_PREFETCH_AHEAD, Math.max(0, chapterCount - currentChapterIndex));
  const chapterIndexes = Array.from({ length: prefetchCount }, (_, offset) => currentChapterIndex + offset + 1);
  return prefetchReaderChapters(bookId, chapterIndexes);
}

function getReaderScrollRatio(readerElement: HTMLElement): number {
  return getContentScrollRatio(readerElement.scrollTop, getReaderContentScrollEnd(readerElement));
}

function getScrollTopForRatio(readerElement: HTMLElement, scrollRatio: number): number {
  const maxScrollTop = getReaderContentScrollEnd(readerElement);
  return Math.round(Math.max(0, maxScrollTop) * Math.min(1, Math.max(0, scrollRatio)));
}

function getReaderLayoutKey(preferences: ReaderPreferences, furigana?: JapaneseFuriganaMode, translation?: JapaneseTranslationMode): string {
  return JSON.stringify([preferences.chineseScript, preferences.contentWidth, preferences.fontFamily, preferences.fontScale, preferences.fontWeight, preferences.lineHeight, preferences.japaneseLayout, preferences.pagePadding, preferences.paragraphSpacing, preferences.readingMode, preferences.textAlign, preferences.textIndent, furigana, translation]);
}
