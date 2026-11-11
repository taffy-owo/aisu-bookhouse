import {
  ArrowLeft,
  BookOpenText,
  Download,
  ExternalLink,
  Expand,
  FileImage,
  LoaderCircle,
  Minus,
  MoreHorizontal,
  PanelLeft,
  Palette,
  Plus,
  RefreshCw,
  Shrink,
  Type,
  NotebookPen,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { cn } from '../../../shared/utils/cn';
import { useMediaQuery } from '../../../shared/hooks/useMediaQuery';
import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import { normalizeRequestedPageIndex } from '../utils/readerLocator';
import { calculatePdfFallbackWidth, calculatePdfPageWidth, calculatePdfPageZoom, clampPdfPage, getPdfProgressPercent, PDF_MAX_ZOOM, PDF_MIN_ZOOM, stepPdfZoom } from '../services/pdfReaderLayout';
import type { PdfFitMode, PdfPageSize } from '../services/pdfReaderLayout';
import { disposePdfPresentation, getPreparedPdfPage, paintPdfPageFrame, preparePdfPage, readPdfPageText, releasePreparedPdfPages, renderPdfPageFrame, setPreparedPdfPages, waitForPdfPresentationFrame } from '../services/pdfPagePresentation';
import type { PdfPagePresentation } from '../services/pdfPagePresentation';
import { createPdfPageStartAnchor, readPdfPageAnchor, restorePdfPageAnchor } from '../services/pdfPageAnchor';
import type { PdfPageAnchor } from '../services/pdfPageAnchor';
import { usePdfExternalOpen } from '../hooks/usePdfExternalOpen';
import { createPdfDocumentController, type PdfDocumentController, type PdfUrlResolver } from '../services/pdfDocumentController';
import { useReaderControls } from '../hooks/useReaderControls';
import { isReaderInteractiveTarget, useReaderTouchGestures } from '../hooks/useReaderTouchGestures';
import { useReaderPanelDismiss } from '../hooks/useReaderPanelDismiss';
import { getPdfScreenStep, isPdfPageEndVisible } from '../services/pdfTouchNavigation';
import { shouldIgnoreReaderKeyboardEvent } from '../services/readerKeyboard';
import { DEFAULT_READER_PREFERENCES, type ReaderPreferences } from '../services/readerPreferences';
import { readerBodyFontClass } from '../constants/readerDisplayClasses';
import { ReaderFontSizeControl, ReaderSettingsPanel } from './ReaderSettingsPanel';
import { PdfThumbnailSidebar } from './PdfThumbnailSidebar';
import { PdfTextLayer } from './PdfTextLayer';
import { getAutoParagraphAlignment } from '../utils/readerParagraphAlignment';
import type { ReaderEditionSwitch } from '../hooks/useReaderEditionSwitch';
import { isMediaPageVisible } from '../services/mediaReadingProgress';
import { useReadingActivityTracker } from '../hooks/useReadingActivityTracker';
import { getAccountScope } from '../../../shared/api';

// pdf.js destroys a loading task's worker during cancellation. A shared
// workerPort becomes unusable when React remounts this reader (including in
// StrictMode), so let each loading task create its own worker from the URL.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfReaderProps = {
  bookId?: string;
  statusContent?: ReactNode;
  progressPercent?: number;
  editionSwitch?: ReaderEditionSwitch;
  isOverlayOpen?: boolean;
  onOpenMarks?: () => void;
  onCheckUpdate?: () => void;
  pageRequest?: { pageNumber: number };
  downloadDisabled?: boolean;
  isDownloadPreparing?: boolean;
  downloadError?: string | null;
  initialPage?: number;
  onBack: () => void;
  onDownload: () => void;
  onLeave?: () => void;
  onPageChange?: (pageNumber: number, pageCount: number, initial?: boolean, hasReadPageEnd?: boolean) => void;
  onPageCountChange?: (pageCount: number) => void;
  onPreferencesChange: (preferences: ReaderPreferences) => void;
  preferences: ReaderPreferences;
  refreshUrl?: PdfUrlResolver;
  title: string;
  url: string;
};

type PdfViewMode = 'page' | 'text';
const PDF_DESKTOP_CONTROLS_QUERY = '(min-width: 1280px) and (hover: hover) and (pointer: fine)';
type PdfTextPageLayout = { kind: 'text' | 'canvas'; size: PdfPageSize; ready: boolean };
const textPageHeightCache = new WeakMap<PDFDocumentProxy, { exact: Map<string, number>; recent: Map<number, number> }>();

function getTextPageHeightCache(document: PDFDocumentProxy) {
  let cache = textPageHeightCache.get(document);
  if (!cache) {
    cache = { exact: new Map(), recent: new Map() };
    textPageHeightCache.set(document, cache);
  }
  return cache;
}

export function PdfReader({ bookId, statusContent, progressPercent, editionSwitch, isOverlayOpen = false, onOpenMarks, onCheckUpdate, pageRequest, downloadDisabled = false, isDownloadPreparing = false, downloadError, initialPage = 1, onBack, onDownload, onLeave, onPageChange, onPageCountChange, onPreferencesChange, preferences, refreshUrl, title, url }: PdfReaderProps) {
  const shellRef = useRef<HTMLElement | null>(null);
  const sidebarOpenerRef = useRef<HTMLButtonElement | null>(null);
  const toolsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const sidebarId = useId();
  const touchTargetRef = useRef<HTMLDivElement | null>(null);
  const hasDesktopControls = useMediaQuery(PDF_DESKTOP_CONTROLS_QUERY);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pageStackRef = useRef<HTMLDivElement | null>(null);
  const measuredAvailableRef = useRef<{ width: number; height: number; mode: PdfViewMode } | null>(null);
  const captureResizeAnchorRef = useRef<() => void>(() => {});
  const recordViewportAnchorRef = useRef<() => void>(() => {});
  const pageElementRefs = useRef(new Map<number, HTMLDivElement>());
  const scrollFrameRef = useRef<number | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointerTypeRef = useRef('');
  const previousViewModeRef = useRef<PdfViewMode | null>(null);
  const pendingZoomAnchorRef = useRef<PdfPageAnchor | null>(null);
  const lastViewportAnchorRef = useRef<{ document: PDFDocumentProxy; mode: PdfViewMode; anchor: PdfPageAnchor } | null>(null);
  const capturePageAnchorRef = useRef<() => void>(() => {});
  const restoredDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const requestedPageRef = useRef<number | null>(null);
  const pendingPageNavigationRef = useRef<number | null>(null);
  const pinRequestedPageRef = useRef(false);
  const appliedPageRequestRef = useRef<typeof pageRequest>(undefined);
  const pendingTextPageJumpRef = useRef<number | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [renderedPages, setRenderedPages] = useState<{ document: PDFDocumentProxy; pages: Set<number> } | null>(null);
  const [readablePage, setReadablePage] = useState<{ document: PDFDocumentProxy; page: number } | null>(null);
  const [activityAccountScope] = useState(getAccountScope);
  const lastReportedPageRef = useRef<{ document: PDFDocumentProxy; page: number; initial: boolean; hasReadPageEnd: boolean } | null>(null);
  const reportVisiblePageRef = useRef<(pageNumber: number) => void>(() => {});
  const [documentError, setDocumentError] = useState('');
  const documentControllerRef = useRef<PdfDocumentController | null>(null);
  const [isDocumentLoading, setIsDocumentLoading] = useState(false);
  const pageHistoryRef = useRef({ page: Math.max(1, Math.floor(initialPage) || 1), revision: 0 });
  const loadIntentRef = useRef({ page: Math.max(1, Math.floor(initialPage) || 1), revision: 0 });
  const initialPageRef = useRef(initialPage);
  const checkUpdateRef = useRef(onCheckUpdate);
  const retryPreflightRef = useRef<AbortController | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const retryPageRef = useRef<number | null>(null);
  const reloadAnchorRef = useRef<{ document: PDFDocumentProxy; anchor: PdfPageAnchor } | null>(null);
  const retryViewRef = useRef<{
    document: PDFDocumentProxy | null; scroll: HTMLDivElement | null; mode: PdfViewMode;
    availableSize: PdfPageSize; customZoom: number; fitMode: PdfFitMode; fallbackZoom: number;
    fontSize: number; fontFamily: ReaderPreferences['fontFamily'];
  } | null>(null);
  const [pageSize, setPageSize] = useState<PdfPageSize | null>(null);
  const [availableSize, setAvailableSize] = useState({ height: 0, width: 0 });
  const [currentPage, setCurrentPage] = useState(() => Math.max(1, Math.floor(initialPage) || 1));
  const [pageInput, setPageInput] = useState(() => String(Math.max(1, Math.floor(initialPage) || 1)));
  const pageInputComposingRef = useRef(false);
  const [fitMode, setFitMode] = useState<PdfFitMode>(() => window.matchMedia(PDF_DESKTOP_CONTROLS_QUERY).matches ? 'page' : 'width');
  const [customZoom, setCustomZoom] = useState(1);
  const [fallbackZoom, setFallbackZoom] = useState(1);
  const textFontSize = preferences.pdfTextFontSize;
  const [textPageLayouts, setTextPageLayouts] = useState<{ document: PDFDocumentProxy; pages: Record<number, PdfTextPageLayout> } | null>(null);
  const [viewMode, setViewMode] = useState<PdfViewMode>(() => window.matchMedia(PDF_DESKTOP_CONTROLS_QUERY).matches ? 'page' : 'text');
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [hasReadPageEnd, setHasReadPageEnd] = useState(false);
  const pendingTapRef = useRef<{ x: number; y: number; at: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelPendingTap = useCallback(() => {
    if (pendingTapRef.current) clearTimeout(pendingTapRef.current.timer);
    pendingTapRef.current = null;
  }, []);
  useEffect(() => cancelPendingTap, [cancelPendingTap, pdfDocument, isOverlayOpen, isSettingsOpen, isSidebarOpen, isToolsOpen, viewMode]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [isFullscreenPending, setIsFullscreenPending] = useState(false);
  const fullscreenRequestRef = useRef<symbol | null>(null);
  useEffect(() => () => { fullscreenRequestRef.current = null; }, []);
  const { isControlsVisible: isMobileControlsVisible, hideControls: hideMobileControls, showControls: showMobileControls, toggleControls: toggleMobileControls } = useReaderControls(true, isSidebarOpen || isSettingsOpen || isToolsOpen || isOverlayOpen);
  const closeSidebar = useCallback(() => {
    setIsSidebarOpen(false); showMobileControls();
    window.requestAnimationFrame(() => sidebarOpenerRef.current?.focus({ preventScroll: true }));
  }, [showMobileControls]);
  const closeTools = useCallback(() => {
    setIsToolsOpen(false); showMobileControls();
    window.requestAnimationFrame(() => toolsOpenerRef.current?.focus({ preventScroll: true }));
  }, [showMobileControls]);
  const setReaderScrollElement = useCallback((element: HTMLDivElement | null) => { touchTargetRef.current = element; setScrollElement(element); }, []);
  const externalOpen = usePdfExternalOpen(url, refreshUrl);
  useLayoutEffect(() => {
    retryViewRef.current = { document: pdfDocument, scroll: scrollElement, mode: viewMode, availableSize, customZoom, fitMode, fallbackZoom, fontSize: textFontSize, fontFamily: preferences.fontFamily };
  }, [availableSize, customZoom, fallbackZoom, fitMode, pdfDocument, preferences.fontFamily, scrollElement, textFontSize, viewMode]);
  useEffect(() => () => { retryPreflightRef.current?.abort(); retryPreflightRef.current = null; }, [refreshUrl, url]);
  const retryDocument = useCallback((pageNumber?: number) => {
    if (retryPreflightRef.current || documentControllerRef.current?.isLoading()) return;
    const controller = new AbortController();
    retryPreflightRef.current = controller;
    setIsRetrying(true);
    setRetryError('');
    const intent = { page: pageNumber ?? pageHistoryRef.current.page, revision: pageHistoryRef.current.revision };
    void (async () => {
      const resolvedUrl = refreshUrl ? await refreshUrl(controller.signal) : url;
      if (controller.signal.aborted) return;
      loadIntentRef.current = intent;
      setDocumentError('');
      void documentControllerRef.current?.load(resolvedUrl);
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : '文件检查失败，请重试。';
        setRetryError(message);
        if (!pdfDocument) setDocumentError(message);
      }
    }).finally(() => {
      if (retryPreflightRef.current === controller) {
        retryPreflightRef.current = null;
        setIsRetrying(false);
      }
    });
  }, [pdfDocument, refreshUrl, url]);

  const registerPageFrame = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const pageNumber = Number(element.dataset.pdfPage);
    pageElementRefs.current.set(pageNumber, element);
    return () => { pageElementRefs.current.delete(pageNumber); };
  }, []);

  useLayoutEffect(() => {
    if (pageHistoryRef.current.page !== currentPage) pageHistoryRef.current = { page: currentPage, revision: pageHistoryRef.current.revision + 1 };
    initialPageRef.current = initialPage;
    checkUpdateRef.current = onCheckUpdate;
  }, [currentPage, initialPage, onCheckUpdate]);

  useEffect(() => {
    const controller = createPdfDocumentController({
      load: (nextUrl: string) => {
        const task = getDocument({ rangeChunkSize: 128 * 1024, url: nextUrl });
        let ownedDocument: PDFDocumentProxy | null = null;
        return {
          promise: task.promise.then((document) => { ownedDocument = document; return document; }),
          destroy: () => { if (ownedDocument) releasePreparedPdfPages(ownedDocument); return task.destroy(); },
        };
      },
      prepare: async (document: PDFDocumentProxy, signal: AbortSignal) => {
        const firstPage = await document.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('PDF 页面尺寸无效');
        const size = { height: viewport.height, width: viewport.width };
        const targetPage = () => clampPdfPage(pageHistoryRef.current.revision === loadIntentRef.current.revision ? loadIntentRef.current.page : pageHistoryRef.current.page, document.numPages);
        if (!retryViewRef.current?.document) {
          if (targetPage() !== 1) await document.getPage(targetPage());
          return { document, size, targetPage: targetPage() };
        }
        const inputs = () => {
          const view = retryViewRef.current!;
          const target = targetPage();
          const bounds = view.scroll?.getBoundingClientRect();
          const visible = target === pageHistoryRef.current.page && bounds ? [...pageElementRefs.current.entries()].filter(([page, frame]) => {
            const rect = frame.getBoundingClientRect();
            return page <= document.numPages && rect.bottom > bounds.top && rect.top < bounds.bottom;
          }).map(([page]) => page) : [];
          const pages = [...new Set([target, ...visible])];
          const key = JSON.stringify([target, pages, view.mode, view.availableSize, view.customZoom, view.fitMode, view.fallbackZoom, view.fontSize, view.fontFamily, window.devicePixelRatio]);
          return { view, target, pages, key };
        };
        while (!signal.aborted) {
          const snapshot = inputs();
          const pages = new Map<number, PdfPagePresentation>();
          try {
            for (const page of snapshot.pages) {
              pages.set(page, await preparePdfPage(document, page, snapshot.view.mode, (pageSize) => snapshot.view.mode === 'text'
                ? calculatePdfFallbackWidth({ availableSize: snapshot.view.availableSize, pageSize, zoom: snapshot.view.fallbackZoom })
                : calculatePdfPageWidth({ availableSize: snapshot.view.availableSize, pageSize: size, customZoom: snapshot.view.customZoom, fitMode: snapshot.view.fitMode }), signal, Boolean(pageElementRefs.current.get(page)?.querySelector('.pdf-reflow-text'))));
            }
            await waitForPdfPresentationFrame(signal);
            if (signal.aborted) throw new DOMException('PDF rendering cancelled', 'AbortError');
            if (snapshot.key !== inputs().key) { pages.forEach(disposePdfPresentation); continue; }
            setPreparedPdfPages(document, pages);
            return { document, size, targetPage: snapshot.target };
          } catch (error) {
            pages.forEach(disposePdfPresentation);
            throw error;
          }
        }
        throw new DOMException('PDF rendering cancelled', 'AbortError');
      },
      onReady: ({ document, size, targetPage }) => {
        retryPageRef.current = targetPage;
        const scroll = retryViewRef.current?.scroll;
        const frame = pageElementRefs.current.get(targetPage);
        const anchor = scroll && frame && targetPage === pageHistoryRef.current.page
          ? pendingPageNavigationRef.current === targetPage && requestedPageRef.current === targetPage
            ? createPdfPageStartAnchor(scroll, targetPage)
            : readPdfPageAnchor(scroll, frame, targetPage)
          : null;
        reloadAnchorRef.current = anchor ? { document, anchor } : null;
        lastViewportAnchorRef.current = null;
        pendingZoomAnchorRef.current = null;
        pendingPageNavigationRef.current = null;
        pendingTextPageJumpRef.current = null;
        setDocumentError('');
        setRetryError('');
        setPdfDocument(document);
        setPageSize(size);
      },
      onError: (error: unknown, hasDocument: boolean) => {
        const message = error instanceof Error ? error.message : 'PDF 加载失败';
        if (hasDocument) setRetryError(message);
        else setDocumentError(message);
        checkUpdateRef.current?.();
      },
      onLoading: setIsDocumentLoading,
    });
    documentControllerRef.current = controller;
    return () => { controller.dispose(); if (documentControllerRef.current === controller) documentControllerRef.current = null; };
  }, []);

  useEffect(() => {
    loadIntentRef.current = { page: retryViewRef.current?.document ? pageHistoryRef.current.page : initialPageRef.current, revision: pageHistoryRef.current.revision };
    setDocumentError('');
    setRetryError('');
    void documentControllerRef.current?.load(url);
  }, [url]);

  useEffect(() => { documentControllerRef.current?.releaseRetired(); }, [pdfDocument]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const stack = pageStackRef.current;
    if (!content || !stack || !scrollElement) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const style = getComputedStyle(stack);
      const width = Math.max(0, scrollElement.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      // Custom zoom may introduce a horizontal scrollbar. Keep its fitted
      // baseline stable instead of resizing the page in response to that bar.
      const height = Math.max(0, content.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
      const previous = measuredAvailableRef.current;
      measuredAvailableRef.current = { width, height, mode: viewMode };
      if (previous?.width === width && previous.height === height) {
        if (!pendingZoomAnchorRef.current) recordViewportAnchorRef.current();
        return;
      }
      if (previous?.mode === viewMode) captureResizeAnchorRef.current();
      setAvailableSize({ width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(scrollElement);
    observer.observe(stack);
    return () => { active = false; observer.disconnect(); };
  }, [scrollElement, viewMode]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === shellRef.current);
      setFullscreenError('');
    };
    window.document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => window.document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const pageCount = pdfDocument?.numPages ?? 0;
  useEffect(() => { onPageCountChange?.(pageCount); }, [onPageCountChange, pageCount]);
  const pageNumbers = useMemo(() => Array.from({ length: pageCount }, (_, index) => index + 1), [pageCount]);
  const pageWidth = calculatePdfPageWidth({ availableSize, customZoom, fitMode, pageSize });
  const originalZoom = calculatePdfPageZoom({ availableSize, customZoom, fitMode, pageSize });
  const currentPageZoom = fitMode === 'custom' ? customZoom : originalZoom.scale;
  const currentTextLayout = textPageLayouts?.document === pdfDocument ? textPageLayouts.pages[currentPage] : undefined;
  const usesTextZoom = viewMode === 'text' && currentTextLayout?.kind === 'text';
  const usesFallbackZoom = viewMode === 'text' && currentTextLayout?.kind === 'canvas';
  const isZoomReady = Boolean(pdfDocument && pageSize && pageWidth && (viewMode === 'page' || currentTextLayout?.ready));
  const zoomOutDisabled = !isZoomReady || (usesTextZoom ? textFontSize <= 16 : usesFallbackZoom ? fallbackZoom <= PDF_MIN_ZOOM : currentPageZoom <= PDF_MIN_ZOOM);
  const zoomInDisabled = !isZoomReady || (usesTextZoom ? textFontSize >= 26 : usesFallbackZoom ? fallbackZoom >= PDF_MAX_ZOOM : currentPageZoom >= originalZoom.maximum - 0.001);
  const zoomLabel = !isZoomReady ? '…' : usesTextZoom ? `${textFontSize}px` : usesFallbackZoom ? `${Math.round(fallbackZoom * 100)}%` : fitMode === 'page' ? '整页' : fitMode === 'width' ? '适宽' : `${Math.round(customZoom * 100)}%`;
  const resetZoomLabel = usesTextZoom ? '恢复默认字号' : usesFallbackZoom ? '恢复页面大小' : hasDesktopControls ? '适合整页' : '恢复适合宽度';

  const handleTextLayoutReady = useCallback((document: PDFDocumentProxy, pageNumber: number, layout: PdfTextPageLayout) => {
    setTextPageLayouts((previous) => {
      const pages = previous?.document === document ? previous.pages : {};
      const known = pages[pageNumber];
      if (known?.kind === layout.kind && known.ready === layout.ready && known.size.width === layout.size.width && known.size.height === layout.size.height) return previous;
      return { document, pages: { ...pages, [pageNumber]: layout } };
    });
  }, []);

  const handleTextLayoutUnavailable = useCallback((document: PDFDocumentProxy, pageNumber: number) => {
    setTextPageLayouts((previous) => {
      if (previous?.document !== document || !previous.pages[pageNumber]?.ready) return previous;
      return { ...previous, pages: { ...previous.pages, [pageNumber]: { ...previous.pages[pageNumber], ready: false } } };
    });
  }, []);

  useLayoutEffect(() => {
    if (usesTextZoom && scrollElement) scrollElement.scrollTo({ left: 0, behavior: 'auto' });
  }, [scrollElement, usesTextZoom, currentPage]);

  const recordViewportAnchor = useCallback((pageNumber: number) => {
    if (!pdfDocument || !scrollElement) return;
    if (viewMode === 'text' && !(textPageLayouts?.document === pdfDocument && textPageLayouts.pages[pageNumber]?.ready)) return;
    const frame = pageElementRefs.current.get(pageNumber);
    const navigatingTo = pendingPageNavigationRef.current;
    if (navigatingTo !== null) {
      if (requestedPageRef.current !== navigatingTo) pendingPageNavigationRef.current = null;
      else {
        if (!frame || pageNumber !== navigatingTo) return;
        const pageTop = scrollElement.scrollTop + frame.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
        const destination = Math.max(0, Math.min(scrollElement.scrollHeight - scrollElement.clientHeight, pageTop));
        // A smooth jump still shows the old page for its first frames. Its
        // intermediate coordinate must not become a resize/zoom anchor.
        if (Math.abs(scrollElement.scrollTop - destination) > 2) return;
        pendingPageNavigationRef.current = null;
      }
    }
    const anchor = frame && readPdfPageAnchor(scrollElement, frame, pageNumber);
    if (anchor) lastViewportAnchorRef.current = { document: pdfDocument, mode: viewMode, anchor };
  }, [pdfDocument, scrollElement, textPageLayouts, viewMode]);

  const capturePageAnchor = () => {
    if (!scrollElement) return;
    pendingTextPageJumpRef.current = null;
    const navigatingTo = pendingPageNavigationRef.current;
    const page = navigatingTo !== null && requestedPageRef.current === navigatingTo ? navigatingTo : currentPage;
    const frame = pageElementRefs.current.get(page);
    if (navigatingTo === page) frame?.scrollIntoView({ behavior: 'instant', block: 'start' });
    const anchor = frame && readPdfPageAnchor(scrollElement, frame, page);
    if (!anchor) return;
    pendingPageNavigationRef.current = null;
    requestedPageRef.current = page;
    pendingZoomAnchorRef.current = anchor;
  };
  useEffect(() => {
    capturePageAnchorRef.current = capturePageAnchor;
    recordViewportAnchorRef.current = () => recordViewportAnchor(currentPage);
    captureResizeAnchorRef.current = () => {
      const navigatingTo = pendingPageNavigationRef.current;
      if (scrollElement && navigatingTo !== null && requestedPageRef.current === navigatingTo) {
        // A layout change supersedes the animation, but keeps its destination.
        // Restore the requested page's top after the new dimensions render.
        pendingZoomAnchorRef.current = createPdfPageStartAnchor(scrollElement, navigatingTo);
        return;
      }
      const previous = lastViewportAnchorRef.current;
      if (previous?.document !== pdfDocument || previous.mode !== viewMode || previous.anchor.pageNumber !== currentPage) return;
      requestedPageRef.current = currentPage;
      pendingZoomAnchorRef.current = { ...previous.anchor, followViewport: true };
    };
  });

  const handleTextPageHeightChange = useCallback((pageNumber: number, previousHeight: number, nextHeight: number) => {
    if (!scrollElement || pageNumber > currentPage) return;
    // A pending zoom/resize already restores the final geometry. Compensating
    // its preceding pages again would move the reader away from that anchor.
    if (pendingZoomAnchorRef.current) return;
    const previous = lastViewportAnchorRef.current;
    const frame = pageElementRefs.current.get(currentPage);
    if (frame && previous?.document === pdfDocument && previous.mode === viewMode && previous.anchor.pageNumber === currentPage) {
      restorePdfPageAnchor(scrollElement, frame, { ...previous.anchor, followViewport: true });
      recordViewportAnchor(currentPage);
    } else if (pageNumber < currentPage) {
      scrollElement.scrollBy(0, nextHeight - previousHeight);
    }
  }, [currentPage, pdfDocument, recordViewportAnchor, scrollElement, viewMode]);

  const recordPageIntent = useCallback((pageNumber: number, explicit = false) => {
    if (!pageCount) return;
    const changed = pageHistoryRef.current.page !== pageNumber;
    // Selecting the current page still supersedes a pending retry's target.
    if (changed || explicit) pageHistoryRef.current = { page: pageNumber, revision: pageHistoryRef.current.revision + 1 };
  }, [pageCount]);

  const handlePageRendered = useCallback((document: PDFDocumentProxy, page: number) => {
    setRenderedPages((previous) => {
      if (previous?.document === document && previous.pages.has(page)) return previous;
      const pages = new Set(previous?.document === document ? previous.pages : []);
      pages.add(page);
      return { document, pages };
    });
  }, []);
  const handlePageUnavailable = useCallback((document: PDFDocumentProxy, page: number) => {
    setRenderedPages((previous) => {
      if (previous?.document !== document || !previous.pages.has(page)) return previous;
      const pages = new Set(previous.pages);
      pages.delete(page);
      return { document, pages };
    });
  }, []);
  const reportVisiblePage = useCallback((page: number) => {
    if (!pdfDocument || !scrollElement || isOverlayOpen || isSettingsOpen || isToolsOpen || document.visibilityState === 'hidden' || renderedPages?.document !== pdfDocument || !renderedPages.pages.has(page)) { setReadablePage(null); return; }
    const frame = pageElementRefs.current.get(page);
    if (!frame) { setReadablePage(null); return; }
    // Distant jumps must follow the selected page while nearby placeholders
    // acquire their real dimensions, rather than stopping several pages early.
    if (pinRequestedPageRef.current && requestedPageRef.current === page && !pendingZoomAnchorRef.current && !isMediaPageVisible(frame.getBoundingClientRect(), scrollElement.getBoundingClientRect())) frame.scrollIntoView({ behavior: 'instant', block: 'start' });
    if (!isMediaPageVisible(frame.getBoundingClientRect(), scrollElement.getBoundingClientRect())) { setReadablePage(null); return; }
    const hasReadPageEnd = isPdfPageEndVisible(frame.getBoundingClientRect().bottom, scrollElement.getBoundingClientRect().bottom);
    setHasReadPageEnd(hasReadPageEnd);
    setReadablePage((previous) => previous?.document === pdfDocument && previous.page === page ? previous : { document: pdfDocument, page });
    const previous = lastReportedPageRef.current;
    if (previous?.document === pdfDocument && previous.page === page && previous.hasReadPageEnd === hasReadPageEnd) return;
    const initial = !previous || (previous.initial && previous.page === page && previous.hasReadPageEnd === hasReadPageEnd);
    lastReportedPageRef.current = { document: pdfDocument, page, initial, hasReadPageEnd };
    onPageChange?.(page, pageCount, initial, hasReadPageEnd);
  }, [isOverlayOpen, isSettingsOpen, isToolsOpen, onPageChange, pageCount, pdfDocument, renderedPages, scrollElement]);
  useLayoutEffect(() => { reportVisiblePageRef.current = reportVisiblePage; }, [reportVisiblePage]);
  useEffect(() => {
    let frame: number | undefined;
    const report = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => { frame = undefined; reportVisiblePage(currentPage); });
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', report); };
  }, [currentPage, reportVisiblePage]);
  useReadingActivityTracker(Boolean(
    pdfDocument && renderedPages?.document === pdfDocument && renderedPages.pages.has(currentPage)
    && readablePage?.document === pdfDocument && readablePage.page === currentPage
    && !isOverlayOpen && !isSettingsOpen && !isToolsOpen && activityAccountScope === getAccountScope(),
  ), bookId);

  useLayoutEffect(() => {
    if (!pdfDocument || !scrollElement || !pageWidth || restoredDocumentRef.current === pdfDocument) return;
    restoredDocumentRef.current = pdfDocument;
    const restoredPage = clampPdfPage(retryPageRef.current ?? initialPage, pdfDocument.numPages);
    retryPageRef.current = null;
    requestedPageRef.current = restoredPage;
    const anchor = reloadAnchorRef.current?.document === pdfDocument ? reloadAnchorRef.current.anchor : null;
    reloadAnchorRef.current = null;
    pinRequestedPageRef.current = !anchor && restoredPage > 1;
    pendingTextPageJumpRef.current = !anchor && viewMode === 'text' ? restoredPage : null;
    setCurrentPage(restoredPage);
    setPageInput(String(restoredPage));
    const restore = () => {
      const frame = pageElementRefs.current.get(restoredPage);
      if (!frame) return;
      if (anchor) restorePdfPageAnchor(scrollElement, frame, anchor);
      else frame.scrollIntoView({ block: 'start' });
      const nextAnchor = readPdfPageAnchor(scrollElement, frame, restoredPage);
      if (nextAnchor) lastViewportAnchorRef.current = { document: pdfDocument, mode: viewMode, anchor: nextAnchor };
    };
    if (getPreparedPdfPage(pdfDocument, restoredPage)) { restore(); return; }
    const frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [initialPage, pageWidth, pdfDocument, scrollElement, viewMode]);

  useEffect(() => {
    const targetPage = pendingTextPageJumpRef.current;
    if (viewMode !== 'text' || !scrollElement || !pdfDocument || targetPage === null || textPageLayouts?.document !== pdfDocument || !textPageLayouts.pages[targetPage]?.ready) return;
    const frame = window.requestAnimationFrame(() => {
      if (pendingTextPageJumpRef.current !== targetPage) return;
      pendingTextPageJumpRef.current = null;
      pageElementRefs.current.get(targetPage)?.scrollIntoView({ block: 'start' });
      recordViewportAnchor(targetPage);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentPage, pdfDocument, recordViewportAnchor, scrollElement, textPageLayouts, viewMode]);

  useEffect(() => {
    const flushProgress = () => {
      onLeave?.();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushProgress();
    };
    window.addEventListener('pagehide', flushProgress);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushProgress);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      flushProgress();
    };
  }, [onLeave]);

  useEffect(() => {
    const scroller = scrollElement;
    if (!scroller || !pageWidth) return;
    const frame = window.requestAnimationFrame(() => {
      const anchor = pendingZoomAnchorRef.current;
      pendingZoomAnchorRef.current = null;
      if (anchor) {
        const frame = pageElementRefs.current.get(anchor.pageNumber);
        if (frame) restorePdfPageAnchor(scroller, frame, anchor);
      }
      recordViewportAnchor(anchor?.pageNumber ?? currentPage);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pageWidth, textFontSize, fallbackZoom, preferences.fontFamily, availableSize.width, availableSize.height, currentPage, recordViewportAnchor, scrollElement]);

  const goToPage = useCallback((requestedPage: number, behavior?: ScrollBehavior) => {
    pendingZoomAnchorRef.current = null;
    const nextPage = clampPdfPage(requestedPage, pageCount || 1);
    pendingPageNavigationRef.current = nextPage;
    lastViewportAnchorRef.current = null;
    const distantJump = Math.abs(nextPage - currentPage) > 1;
    pinRequestedPageRef.current = distantJump;
    requestedPageRef.current = nextPage;
    const isTextLayoutReady = textPageLayouts?.document === pdfDocument && textPageLayouts.pages[nextPage]?.ready;
    pendingTextPageJumpRef.current = viewMode === 'text' && !isTextLayoutReady ? nextPage : null;
    const pageElement = scrollElement?.querySelector<HTMLElement>(`[data-pdf-page="${nextPage}"]`);
    pageElement?.scrollIntoView({ behavior: behavior ?? (viewMode === 'text' || distantJump ? 'auto' : 'smooth'), block: 'start' });
    recordPageIntent(nextPage, true);
    setCurrentPage(nextPage);
    setPageInput(String(nextPage));
  }, [currentPage, pageCount, pdfDocument, recordPageIntent, scrollElement, textPageLayouts, viewMode]);

  useEffect(() => {
    if (!pageRequest || appliedPageRequestRef.current === pageRequest || !pdfDocument || !scrollElement) return;
    appliedPageRequestRef.current = pageRequest;
    goToPage(pageRequest.pageNumber, 'auto');
  }, [goToPage, pageRequest, pdfDocument, scrollElement]);

  useEffect(() => {
    if (previousViewModeRef.current === viewMode) return;
    previousViewModeRef.current = viewMode;
    if (!pdfDocument || !scrollElement) return;
    lastViewportAnchorRef.current = null;
    pendingZoomAnchorRef.current = null;
    requestedPageRef.current = currentPage;
    pendingTextPageJumpRef.current = viewMode === 'text' ? currentPage : null;
    const frame = window.requestAnimationFrame(() => {
      scrollElement.querySelector<HTMLElement>(`[data-pdf-page="${currentPage}"]`)?.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentPage, pdfDocument, scrollElement, viewMode]);

  const handleScroll = useCallback(() => {
    cancelPendingTap();
    if (!hasDesktopControls && isMobileControlsVisible && requestedPageRef.current === null) hideMobileControls();
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scroller = scrollElement;
      if (!scroller) return;
      const focusLine = scroller.getBoundingClientRect().top + Math.min(scroller.clientHeight * 0.32, 240);
      let low = 1;
      let high = pageCount;
      let nearestPage = pageCount || currentPage;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const page = pageElementRefs.current.get(middle);
        if (!page) break;
        const rect = page.getBoundingClientRect();
        if (rect.bottom < focusLine) {
          low = middle + 1;
        } else {
          nearestPage = middle;
          high = middle - 1;
        }
      }
      if (nearestPage > 1) {
        const currentRect = pageElementRefs.current.get(nearestPage)?.getBoundingClientRect();
        const previousRect = pageElementRefs.current.get(nearestPage - 1)?.getBoundingClientRect();
        if (currentRect && previousRect && focusLine < currentRect.top && currentRect.top - focusLine > focusLine - previousRect.bottom) {
          nearestPage -= 1;
        }
      }
      // A short final page may not align with the viewport's focus line.
      // Keep an explicit jump selected until the user starts scrolling again.
      if (requestedPageRef.current !== null) nearestPage = requestedPageRef.current;
      else if (scroller.scrollTop > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) nearestPage = pageCount || currentPage;
      recordViewportAnchor(nearestPage);
      reportVisiblePageRef.current(nearestPage);
      if (nearestPage !== currentPage) {
        recordPageIntent(nearestPage);
        setCurrentPage(nearestPage);
        setPageInput(String(nearestPage));
      }
    });
  }, [cancelPendingTap, currentPage, hasDesktopControls, hideMobileControls, isMobileControlsVisible, pageCount, recordViewportAnchor, recordPageIntent, scrollElement]);

  const commitPageInput = () => {
    if (pageInputComposingRef.current) return;
    const requestedPage = normalizeRequestedPageIndex(pageInput, pageCount);
    if (requestedPage === null || requestedPage === currentPage) setPageInput(String(currentPage));
    else goToPage(requestedPage);
  };
  const changeTextFontSize = useCallback((delta: number) => {
    const next = Math.min(26, Math.max(16, textFontSize + delta));
    if (next === textFontSize) return;
    if (usesTextZoom) capturePageAnchorRef.current();
    onPreferencesChange({ ...preferences, pdfTextFontSize: next });
  }, [onPreferencesChange, preferences, textFontSize, usesTextZoom]);
  const changeZoom = useCallback((delta: number) => {
    if (!isZoomReady) return;
    showMobileControls();
    if (usesTextZoom) {
      changeTextFontSize(Math.sign(delta) * 2);
      return;
    }
    if (usesFallbackZoom) {
      const next = stepPdfZoom(fallbackZoom, delta);
      if (next === fallbackZoom) return;
      capturePageAnchorRef.current();
      setFallbackZoom(next);
      return;
    }
    const next = stepPdfZoom(currentPageZoom, delta, originalZoom.maximum);
    if (Math.abs(next - currentPageZoom) < 0.0001) return;
    capturePageAnchorRef.current();
    setFitMode('custom');
    setCustomZoom(next);
  }, [changeTextFontSize, currentPageZoom, fallbackZoom, isZoomReady, originalZoom.maximum, showMobileControls, usesFallbackZoom, usesTextZoom]);
  const resetZoom = () => {
    if (!isZoomReady) return;
    showMobileControls();
    const fit = hasDesktopControls ? 'page' : 'width';
    if (usesTextZoom ? textFontSize === 18 : usesFallbackZoom ? fallbackZoom === 1 : fitMode === fit && customZoom === 1) return;
    capturePageAnchor();
    if (usesTextZoom) onPreferencesChange({ ...preferences, pdfTextFontSize: DEFAULT_READER_PREFERENCES.pdfTextFontSize });
    else if (usesFallbackZoom) setFallbackZoom(1);
    else { setFitMode(fit); setCustomZoom(1); }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.target === document.body || event.target === scrollElement) && [' ', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
        pendingZoomAnchorRef.current = null;
        pendingTextPageJumpRef.current = null;
        requestedPageRef.current = null;
        handleScroll();
      }
      if ((event.ctrlKey || event.metaKey) && ['f', 'g'].includes(event.key.toLowerCase())) {
        pendingZoomAnchorRef.current = null;
        pendingTextPageJumpRef.current = null;
        requestedPageRef.current = null;
      }
      if (shouldIgnoreReaderKeyboardEvent(event)) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        goToPage(currentPage + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        goToPage(currentPage - 1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        goToPage(event.key === 'Home' ? 1 : pageCount);
      } else if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault();
        changeZoom(event.key === '-' ? -0.1 : 0.1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [changeZoom, currentPage, goToPage, handleScroll, pageCount, scrollElement]);
  const toggleViewMode = () => {
    setViewMode((mode) => mode === 'text' ? 'page' : 'text');
    showMobileControls();
  };
  const handleReaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button === 1) {
      // Native middle-button autoscroll emits no wheel events. Release the
      // navigation lock before it scrolls, or visibility tracking pins it back.
      pendingZoomAnchorRef.current = null;
      pendingTextPageJumpRef.current = null;
      pendingPageNavigationRef.current = null;
      requestedPageRef.current = null;
      pinRequestedPageRef.current = false;
      handleScroll();
    }
    if (!event.isPrimary || event.button !== 0) {
      tapStartRef.current = null;
      cancelPendingTap();
      return;
    }
    lastPointerTypeRef.current = event.pointerType;
    tapStartRef.current = { x: event.clientX, y: event.clientY };
  };
  const handleReaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = tapStartRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      cancelPendingTap();
      pendingZoomAnchorRef.current = null;
      pendingTextPageJumpRef.current = null;
      requestedPageRef.current = null;
      handleScroll();
    }
  };
  const handleReaderPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = tapStartRef.current;
    tapStartRef.current = null;
    if (event.button !== 0 || event.pointerType === 'touch' || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10 || isReaderInteractiveTarget(event.target) || window.getSelection()?.toString().trim()) return;
    toggleMobileControls();
  };
  const zoomAtPoint = useCallback(({ clientX, clientY }: { clientX: number; clientY: number }) => {
    const frame = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-pdf-page]');
    const canvas = frame?.querySelector('.pdf-canvas-page');
    if (viewMode === 'text' && !canvas) return;
    const page = canvas ?? frame;
    const scroller = scrollElement;
    if (!frame || !page || !scroller) return;
    const targetPage = Number(frame.dataset.pdfPage) || currentPage;
    pendingTextPageJumpRef.current = null;
    requestedPageRef.current = targetPage;
    recordPageIntent(targetPage, true);
    setCurrentPage(targetPage);
    setPageInput(String(targetPage));
    const pageRect = page.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    pendingZoomAnchorRef.current = {
      pageNumber: targetPage,
      relativeX: Math.min(1, Math.max(0, (clientX - pageRect.left) / pageRect.width)),
      relativeY: Math.min(1, Math.max(0, (clientY - pageRect.top) / pageRect.height)),
      viewportX: clientX - scrollerRect.left,
      viewportY: clientY - scrollerRect.top,
      overflowY: 0,
    };
    if (viewMode === 'text') {
      setFallbackZoom((value) => value > 1.05 ? 1 : 1.7);
    } else if (fitMode === 'custom' && customZoom > 1.05) {
      setFitMode('width');
      setCustomZoom(1);
    } else {
      setFitMode('custom');
      setCustomZoom(Math.min(originalZoom.maximum, Math.max(1.7, originalZoom.scale * 1.7)));
    }
    showMobileControls();
  }, [currentPage, customZoom, fitMode, originalZoom.maximum, originalZoom.scale, recordPageIntent, scrollElement, showMobileControls, viewMode]);
  const handleReaderDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (lastPointerTypeRef.current !== 'pen' || isReaderInteractiveTarget(event.target)) return;
    event.preventDefault();
    zoomAtPoint(event);
  };
  const handleTouchTap = useCallback(({ clientX }: { clientX: number; clientY: number }) => {
    const scroller = touchTargetRef.current;
    if (!scroller) return;
    // A claimed touch has no native click to move keyboard focus. Release the
    // old toolbar focus before its focus watcher can reopen the dismissed bar.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-reader-controls]')) active.blur();
    const rect = scroller.getBoundingClientRect();
    const x = clientX - rect.left;
    if (preferences.tapToTurnPage && (x < rect.width * 0.28 || x > rect.width * 0.72)) {
      hideMobileControls();
      pendingZoomAnchorRef.current = null;
      pendingTextPageJumpRef.current = null;
      requestedPageRef.current = null;
      pinRequestedPageRef.current = false;
      const text = scroller.querySelector('.pdf-reflow-text');
      const lineHeight = text ? Number.parseFloat(getComputedStyle(text).lineHeight) : 32;
      scroller.scrollTop = getPdfScreenStep(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight, x < rect.width * 0.28 ? -1 : 1, Number.isFinite(lineHeight) ? lineHeight : 32);
      handleScroll();
    } else toggleMobileControls();
  }, [handleScroll, hideMobileControls, preferences.tapToTurnPage, toggleMobileControls]);
  const handleTouchGestureTap = useCallback((point: { clientX: number; clientY: number }) => {
    const isCanvas = Boolean(document.elementFromPoint(point.clientX, point.clientY)?.closest('.pdf-canvas-page'));
    if (!isCanvas) { cancelPendingTap(); handleTouchTap(point); return; }
    // Canvas double taps zoom around the touched point. Delay only canvas
    // single taps so their first half cannot turn a screen before zooming.
    const previous = pendingTapRef.current;
    cancelPendingTap();
    if (previous && Date.now() - previous.at <= 280 && Math.hypot(point.clientX - previous.x, point.clientY - previous.y) <= 32) {
      zoomAtPoint(point);
      return;
    }
    if (previous) handleTouchTap({ clientX: previous.x, clientY: previous.y });
    pendingTapRef.current = { x: point.clientX, y: point.clientY, at: Date.now(), timer: setTimeout(() => { pendingTapRef.current = null; handleTouchTap(point); }, 280) };
  }, [cancelPendingTap, handleTouchTap, zoomAtPoint]);
  useReaderTouchGestures({
    enabled: Boolean(pdfDocument && scrollElement && !isOverlayOpen && !isSidebarOpen && !isSettingsOpen && !isToolsOpen),
    onTap: handleTouchGestureTap,
    targetRef: touchTargetRef,
  });
  const toggleFullscreen = async () => {
    if (fullscreenRequestRef.current) return;
    const request = Symbol();
    fullscreenRequestRef.current = request;
    const exiting = document.fullscreenElement === shellRef.current;
    setFullscreenError('');
    setIsFullscreenPending(true);
    try {
      if (exiting) {
        if (typeof document.exitFullscreen !== 'function') throw new Error('unsupported');
        await document.exitFullscreen();
      } else {
        const shell = shellRef.current;
        if (!shell || typeof shell.requestFullscreen !== 'function') {
          if (fullscreenRequestRef.current === request) setFullscreenError('当前浏览器不支持全屏，可继续正常阅读。');
          return;
        }
        await shell.requestFullscreen();
      }
      if (fullscreenRequestRef.current === request) setIsFullscreen(document.fullscreenElement === shellRef.current);
    } catch {
      if (fullscreenRequestRef.current === request) setFullscreenError(exiting ? '未能退出全屏，请重试或按 Esc。' : '未能进入全屏，请重试。');
    } finally {
      if (fullscreenRequestRef.current === request) {
        fullscreenRequestRef.current = null;
        setIsFullscreenPending(false);
      }
    }
  };
  const selectThumbnail = (page: number) => {
    goToPage(page);
    if (!hasDesktopControls) closeSidebar();
  };
  const zoomControls = <>
    <IconButton disabled={zoomOutDisabled} label={usesTextZoom ? '减小字号' : '缩小'} onClick={() => changeZoom(-0.1)}><Minus className="h-4 w-4" /></IconButton>
    <button aria-label={resetZoomLabel} className="h-11 min-w-14 rounded-md px-2 text-xs tabular-nums transition hover:bg-white/10 hover:text-[color:var(--reader-ink)] aria-disabled:opacity-35" aria-disabled={!isZoomReady} onClick={resetZoom} title={resetZoomLabel} type="button">{zoomLabel}</button>
    <IconButton disabled={zoomInDisabled} label={usesTextZoom ? '增大字号' : '放大'} onClick={() => changeZoom(0.1)}><Plus className="h-4 w-4" /></IconButton>
    {viewMode === 'page' && <button aria-pressed={fitMode === 'width'} className={cn('h-11 rounded-md px-2.5 text-xs transition hover:bg-white/10 hover:text-[color:var(--reader-ink)]', fitMode === 'width' && 'bg-[#b5a08a]/[0.15] text-[color:var(--reader-accent)]')} onClick={() => { capturePageAnchor(); setFitMode(fitMode === 'width' ? 'page' : 'width'); showMobileControls(); }} title="切换适合宽度" type="button">适宽</button>}
  </>;
  const fileActions = <>
    {!hasDesktopControls && editionSwitch && <IconButton label="打开阅读设置" onClick={() => { setIsToolsOpen(false); setIsSettingsOpen(true); }}><Palette className="h-4 w-4" /></IconButton>}
    {onOpenMarks && <IconButton label="打开书签与备注" onClick={() => { setIsToolsOpen(false); onOpenMarks(); }}><NotebookPen className="h-[18px] w-[18px]" /></IconButton>}
    <IconButton disabled={isFullscreenPending} label={isFullscreen ? '退出全屏' : '全屏'} onClick={() => void toggleFullscreen()}>{isFullscreenPending ? <LoaderCircle className="h-[18px] w-[18px] animate-spin" /> : isFullscreen ? <Shrink className="h-[18px] w-[18px]" /> : <Expand className="h-[18px] w-[18px]" />}</IconButton>
    <IconButton label="下载原文件" disabled={downloadDisabled || isDownloadPreparing} onClick={onDownload}>{isDownloadPreparing ? <LoaderCircle className="h-[18px] w-[18px] animate-spin" /> : <Download className="h-[18px] w-[18px]" />}</IconButton>
    <IconButton disabled={externalOpen.isOpening} label="在新标签页打开" onClick={() => void externalOpen.open()}>{externalOpen.isOpening ? <LoaderCircle className="h-[18px] w-[18px] animate-spin" /> : <ExternalLink className="h-[18px] w-[18px]" />}</IconButton>
  </>;

  return (
    <main inert={isOverlayOpen} className={cn('pdf-reader-shell fixed inset-0 z-40 flex min-w-[320px] flex-col overflow-hidden bg-[#10131a] text-[#afa99f]', `reader-theme-${preferences.theme}`)} ref={shellRef} style={{ '--pdf-page-brightness': preferences.pdfBrightness / 100 } as CSSProperties}>
      <header aria-hidden={!hasDesktopControls && !isMobileControlsVisible} data-reader-controls inert={isToolsOpen || (!hasDesktopControls && (!isMobileControlsVisible || isSidebarOpen))} className={cn(
        'pdf-reader-toolbar reader-theme-dark inset-x-0 top-0 z-30 flex shrink-0 bg-[color:var(--reader-page)] text-[color:var(--reader-ink)] shadow-[0_1px_0_rgba(255,255,255,0.06)]',
        hasDesktopControls ? 'relative h-14 items-center gap-1 px-3' : 'relative min-h-[calc(48px+env(safe-area-inset-top))] items-center gap-0 px-1 pb-0.5 pt-[env(safe-area-inset-top)] transition-opacity duration-150 motion-reduce:transition-none',
        !hasDesktopControls && !isMobileControlsVisible && 'pointer-events-none opacity-0',
      )}>
        <IconButton label="返回书籍" onClick={onBack}><ArrowLeft className="h-[18px] w-[18px]" /></IconButton>
        <button ref={sidebarOpenerRef} aria-label="切换缩略图" aria-expanded={isSidebarOpen} aria-controls={isSidebarOpen ? sidebarId : undefined} className={cn('grid h-[44px] w-[44px] shrink-0 place-items-center rounded-md transition hover:bg-white/10 hover:text-[color:var(--reader-ink)]', isSidebarOpen && 'bg-[#b5a08a]/[0.15] text-[color:var(--reader-accent)]')} onClick={() => { setIsSidebarOpen((open) => !open); showMobileControls(); }} title="缩略图" type="button"><PanelLeft className="h-[18px] w-[18px]" /></button>
        {!hasDesktopControls && <IconButton label={viewMode === 'text' ? '切换到原页模式' : '切换到文本模式'} onClick={toggleViewMode}>{viewMode === 'text' ? <FileImage className="h-[18px] w-[18px]" /> : <BookOpenText className="h-[18px] w-[18px]" />}</IconButton>}
        <div className={cn('mx-1 min-w-0 flex-1', !hasDesktopControls && 'hidden')}>
          <p className="truncate text-[13px] font-medium text-[color:var(--reader-ink)]">{title}</p>
          <p className="mt-0.5 truncate text-[10px] text-[color:var(--reader-muted)]" aria-live="polite">{editionSwitch ? editionSwitch.isLoading ? '正在打开新版…' : editionSwitch.error ? '新版打开失败 · 可重试' : '阅读文件已更新 · 打开新版' : isRetrying ? '正在检查文件…' : isDocumentLoading && pdfDocument ? '正在重新加载…' : retryError || 'PDF'}</p>
        </div>

        <div className={cn('flex flex-wrap items-center justify-center gap-0.5', !hasDesktopControls && 'min-w-0 flex-1')}>
          <input
            aria-label="当前页码"
            className="h-[44px] min-w-[44px] rounded bg-[color:var(--reader-shell)] px-1 text-center text-xs text-[color:var(--reader-ink)] outline-none ring-1 ring-[color:var(--reader-hairline)] transition focus:ring-[color:var(--reader-accent)]"
            style={{ width: `calc(${Math.max(2, String(pageCount).length)}ch + 0.5rem + 2px)` }}
            inputMode="numeric"
            onBlur={commitPageInput}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPageInput(event.target.value)}
            onCompositionStart={() => { pageInputComposingRef.current = true; }}
            onCompositionEnd={(event) => { pageInputComposingRef.current = false; setPageInput(event.currentTarget.value); }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || pageInputComposingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              event.currentTarget.blur();
            }}
            value={pageInput}
          />
          <span className="min-w-8 text-xs tabular-nums text-[color:var(--reader-muted)]">/ {pageCount || '--'}</span>
        </div>

        {hasDesktopControls && <div className="flex items-center gap-1">
          <div className="mr-1 flex rounded-md bg-black/[0.24] p-0.5">
            <button aria-pressed={viewMode === 'text'} className={cn('h-[44px] rounded px-2.5 text-xs transition', viewMode === 'text' ? 'bg-[#b5a08a]/[0.15] text-[color:var(--reader-accent)]' : 'text-[color:var(--reader-muted)] hover:text-[color:var(--reader-ink)]')} onClick={() => setViewMode('text')} type="button">文本</button>
            <button aria-pressed={viewMode === 'page'} className={cn('h-[44px] rounded px-2.5 text-xs transition', viewMode === 'page' ? 'bg-[#b5a08a]/[0.15] text-[color:var(--reader-accent)]' : 'text-[color:var(--reader-muted)] hover:text-[color:var(--reader-ink)]')} onClick={() => setViewMode('page')} type="button">原页</button>
          </div>
          <IconButton label="打开阅读设置" onClick={() => { setIsSettingsOpen(true); showMobileControls(); }}>{viewMode === 'text' ? <Type className="h-4 w-4" /> : <Palette className="h-4 w-4" />}</IconButton>
          {zoomControls}
        </div>}

        <div className="ml-auto flex items-center gap-1">
          {editionSwitch && <button aria-label="阅读文件已更新，打开新版阅读器" aria-busy={editionSwitch.isLoading} disabled={editionSwitch.isLoading} title={editionSwitch.error ?? '阅读文件已更新，打开新版阅读器'} className="reader-chrome-action grid h-11 w-11 place-items-center text-[color:var(--reader-accent)] disabled:opacity-50" onClick={editionSwitch.onLoad} type="button"><RefreshCw className={cn('h-[18px] w-[18px]', editionSwitch.isLoading && 'animate-spin')} /><span className="sr-only" aria-live="polite">{editionSwitch.error ? '新版打开失败，请重试；当前内容和草稿已保留。' : '阅读文件已更新'}</span></button>}
          {hasDesktopControls ? fileActions : <>
            {!editionSwitch && <IconButton label="打开阅读设置" onClick={() => { setIsSettingsOpen(true); showMobileControls(); }}>{viewMode === 'text' ? <Type className="h-4 w-4" /> : <Palette className="h-4 w-4" />}</IconButton>}
            <IconButton buttonRef={toolsOpenerRef} label="更多阅读工具" onClick={() => { setIsToolsOpen(true); showMobileControls(); }}><MoreHorizontal className="h-[18px] w-[18px]" /></IconButton>
          </>}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1" inert={isToolsOpen}>
        {isSidebarOpen && <PdfThumbnailSidebar currentPage={currentPage} desktop={hasDesktopControls} id={sidebarId} onClose={closeSidebar} onSelect={selectThumbnail} pageNumbers={pageNumbers}
          renderPage={page => pdfDocument ? <PdfCanvasPage document={pdfDocument} pageNumber={page} pageWidth={126} root={null} /> : null} />}

        <div className="relative min-w-0 flex-1" ref={contentRef} inert={!hasDesktopControls && isSidebarOpen}>
            <div
              className={cn('pdf-reader-scroll absolute inset-0 overflow-auto overscroll-contain', viewMode === 'text' && 'pdf-text-scroll')}
              onDoubleClick={handleReaderDoubleClick}
              onPointerCancel={() => { tapStartRef.current = null; pendingZoomAnchorRef.current = null; pendingTextPageJumpRef.current = null; requestedPageRef.current = null; handleScroll(); }}
              onPointerDown={handleReaderPointerDown}
              onPointerMove={handleReaderPointerMove}
              onPointerUp={handleReaderPointerUp}
              onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showMobileControls(); }}
              onScroll={handleScroll}
              onWheel={() => { pendingZoomAnchorRef.current = null; pendingTextPageJumpRef.current = null; requestedPageRef.current = null; handleScroll(); }}
              ref={setReaderScrollElement}
              aria-label="PDF 阅读内容"
              role="region"
              tabIndex={0}
              style={{ touchAction: 'pan-x pan-y pinch-zoom', overflowX: usesTextZoom ? 'hidden' : 'auto', scrollbarGutter: 'stable' }}
            >
              <div className={cn('mx-auto flex min-h-full min-w-full flex-col items-center', viewMode === 'text' ? 'pdf-text-stack w-full gap-0 px-0 py-0 sm:gap-5 sm:px-6 sm:py-7' : 'w-max gap-3 px-1.5 py-2.5 sm:gap-7 sm:px-6 sm:py-7')} ref={pageStackRef}>
                {pdfDocument && pageSize && pageWidth > 0 && pageNumbers.map((pageNumber) => (
                  <div className={cn('scroll-mt-2.5 sm:scroll-mt-7', viewMode === 'text' && 'w-full')} data-pdf-page={pageNumber} key={pageNumber} ref={registerPageFrame} style={viewMode === 'text' && pageNumber !== currentPage ? { overflow: 'hidden' } : undefined}>
                    {viewMode === 'text' ? (
                      <PdfTextPage
                        availableSize={availableSize}
                        document={pdfDocument}
                        fallbackPageSize={pageSize}
                        fallbackZoom={fallbackZoom}
                        fontSize={textFontSize}
                        fontFamily={preferences.fontFamily}
                        onLayoutReady={handleTextLayoutReady}
                        onRendered={handlePageRendered}
                        onRenderUnavailable={handlePageUnavailable}
                        onLayoutUnavailable={handleTextLayoutUnavailable}
                        onMeasuredHeightChange={handleTextPageHeightChange}
                        onCheckUpdate={onCheckUpdate} onRetry={retryDocument}
                        pageCount={pageCount}
                        pageNumber={pageNumber}
                        placeholderHeight={Math.max(420, availableSize.height)}
                        root={scrollElement}
                      />
                    ) : (
                      <PdfCanvasPage document={pdfDocument} onRendered={handlePageRendered} onRenderUnavailable={handlePageUnavailable} onCheckUpdate={onCheckUpdate} onRetry={retryDocument} pageNumber={pageNumber} pageWidth={pageWidth} root={scrollElement} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          {documentError ? (
            <div className="reader-theme-dark absolute inset-0 grid place-items-center px-5 text-center">
              <div className="max-w-md">
                <p className="text-base font-medium text-[color:var(--reader-ink)]">PDF 无法打开</p>
                <p className="mt-2 text-sm leading-6 text-[color:var(--reader-muted)]">{documentError}</p>
                <button className="mx-auto mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-[color:var(--reader-accent)] px-4 text-sm text-[color:var(--reader-page)] transition hover:opacity-80" onClick={() => retryDocument()} type="button"><RefreshCw className="h-4 w-4" />重新加载</button>
              </div>
            </div>
          ) : !pdfDocument || !pageSize || !pageWidth ? (
            <div className="reader-theme-dark absolute inset-0 grid place-items-center text-sm text-[color:var(--reader-muted)]"><span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-[color:var(--reader-accent)]" />正在准备 PDF</span></div>
          ) : null}
        </div>
      </div>

      <footer inert={isToolsOpen || (!hasDesktopControls && isSidebarOpen)} className="pdf-reading-status reader-theme-dark flex h-[calc(44px+env(safe-area-inset-bottom))] shrink-0 items-start gap-3 bg-[color:var(--reader-shell)] px-4 pb-[env(safe-area-inset-bottom)] text-[11px] text-[color:var(--reader-muted)] sm:px-6">
        {isDownloadPreparing && !isToolsOpen && <span role="status" className="flex h-[44px] shrink-0 items-center">正在准备下载…</span>}
        {fullscreenError && !isToolsOpen && <span role="alert" title={fullscreenError} className="flex h-[44px] min-w-0 flex-1 items-center text-[#d6968b]"><span className="truncate">{fullscreenError}</span></span>}
        <div className="flex h-[44px] min-w-0 flex-1 items-center">{statusContent}<span aria-live="polite" className="min-w-0 truncate" title={downloadError || externalOpen.error || retryError || undefined}>{downloadError || externalOpen.error || (retryError ? pdfDocument ? '重载失败 · 当前页面已保留' : '文件检查失败 · 可重试' : isRetrying ? '正在检查文件…' : isDocumentLoading && pdfDocument ? '正在重新加载…' : '')}</span></div>
        {retryError && <button aria-label="重试加载 PDF" className="reader-chrome-action flex h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 px-2 text-[color:var(--reader-ink)] disabled:opacity-40" disabled={isRetrying || isDocumentLoading} onClick={() => retryDocument()} type="button"><RefreshCw aria-hidden className="h-3.5 w-3.5" />重试</button>}
        <span aria-label="阅读进度" className="flex h-[44px] shrink-0 items-center tabular-nums">{Math.round(progressPercent ?? getPdfProgressPercent(currentPage, pageCount, hasReadPageEnd))}%</span>
      </footer>

      {isToolsOpen && <PdfToolsPanel onClose={closeTools}>
        {isDownloadPreparing && <p role="status" className="mb-3 text-xs leading-5 text-[color:var(--reader-muted)]">正在准备下载…</p>}
        {fullscreenError && <p role="alert" className="mb-3 break-words text-xs leading-5 text-[#d6968b]">{fullscreenError}</p>}
        {downloadError && <p role="alert" className="mb-3 break-words text-xs leading-5 text-[#d6968b]">{downloadError}</p>}
        {externalOpen.error && <p role="alert" className="mb-3 break-words text-xs leading-5 text-[#d6968b]">{externalOpen.error}</p>}
        {externalOpen.isOpening && <p role="status" className="mb-3 text-xs leading-5 text-[color:var(--reader-muted)]">正在准备新标签页…</p>}
        <div className="flex flex-wrap items-center justify-center gap-2 border-b border-[color:var(--reader-hairline)] pb-3">{zoomControls}</div>
        <div className="flex flex-wrap items-center justify-around gap-2 pt-3">{fileActions}</div>
      </PdfToolsPanel>}

      {isSettingsOpen && (
        <ReaderSettingsPanel
          appearanceOnly
          pdfPageAppearance={viewMode === 'page' || usesFallbackZoom}
          fontSizeControl={<ReaderFontSizeControl
            decreaseDisabled={textFontSize <= 16}
            increaseDisabled={textFontSize >= 26}
            label={`${textFontSize}px`}
            onDecrease={() => changeTextFontSize(-2)}
            onIncrease={() => changeTextFontSize(2)}
          />}
          onChange={(next) => {
            if (usesTextZoom && next.fontFamily !== preferences.fontFamily) capturePageAnchor();
            onPreferencesChange(next);
          }}
          onClose={() => { setIsSettingsOpen(false); showMobileControls(); }}
          onReset={() => {
            if (usesTextZoom && (textFontSize !== 18 || preferences.fontFamily !== DEFAULT_READER_PREFERENCES.fontFamily)) capturePageAnchor();
            onPreferencesChange({ ...preferences, theme: DEFAULT_READER_PREFERENCES.theme, fontFamily: DEFAULT_READER_PREFERENCES.fontFamily, pdfBrightness: DEFAULT_READER_PREFERENCES.pdfBrightness, pdfTextFontSize: DEFAULT_READER_PREFERENCES.pdfTextFontSize });
          }}
          preferences={preferences}
        />
      )}

    </main>
  );
}

function PdfTextPage({ onCheckUpdate, availableSize, document, fallbackPageSize, fallbackZoom, fontSize, fontFamily, onLayoutReady, onLayoutUnavailable, onRendered, onRenderUnavailable, onMeasuredHeightChange, onRetry, pageCount, pageNumber, placeholderHeight, root }: {
  availableSize: PdfPageSize;
  document: PDFDocumentProxy;
  fallbackPageSize: PdfPageSize;
  fallbackZoom: number;
  fontSize: number;
  fontFamily: ReaderPreferences['fontFamily'];
  onLayoutReady: (document: PDFDocumentProxy, pageNumber: number, layout: PdfTextPageLayout) => void;
  onLayoutUnavailable: (document: PDFDocumentProxy, pageNumber: number) => void;
  onRendered: (document: PDFDocumentProxy, pageNumber: number) => void;
  onRenderUnavailable: (document: PDFDocumentProxy, pageNumber: number) => void;
  onMeasuredHeightChange: (pageNumber: number, previousHeight: number, nextHeight: number) => void;
  onRetry: (pageNumber: number) => void;
  onCheckUpdate?: () => void;
  pageCount: number;
  pageNumber: number;
  placeholderHeight: number;
  root: Element | null;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  const prepared = getPreparedPdfPage(document, pageNumber);
  const [proximity, setProximity] = useState<{ document: PDFDocumentProxy; near: boolean } | null>(null);
  const isNearViewport = proximity?.document === document ? proximity.near : Boolean(prepared);
  const [loaded, setLoaded] = useState<{ document: PDFDocumentProxy; paragraphs: string[]; size: PdfPageSize } | null>(null);
  const paragraphs = prepared?.paragraphs ?? (loaded?.document === document ? loaded.paragraphs : null);
  const pageSize = prepared?.size ?? (loaded?.document === document ? loaded.size : null);
  const heightCache = getTextPageHeightCache(document);
  const cacheKey = `${pageNumber}:${Math.round(availableSize.width)}:${fontSize}:${fontFamily}:${fallbackZoom}`;
  const reservedHeight = heightCache.exact.get(cacheKey) ?? heightCache.recent.get(pageNumber) ?? placeholderHeight;

  useEffect(() => () => onLayoutUnavailable(document, pageNumber), [document, onLayoutUnavailable, pageNumber]);
  useLayoutEffect(() => {
    if (isNearViewport && prepared?.paragraphs !== undefined) onLayoutReady(document, pageNumber, { kind: prepared.paragraphs.length ? 'text' : 'canvas', size: prepared.size, ready: true });
  }, [document, isNearViewport, onLayoutReady, pageNumber, prepared]);
  useLayoutEffect(() => {
    if (!isNearViewport || !paragraphs?.length) return;
    onRendered(document, pageNumber);
    return () => onRenderUnavailable(document, pageNumber);
  }, [document, isNearViewport, onRendered, onRenderUnavailable, pageNumber, paragraphs]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !isNearViewport || paragraphs === null) return undefined;
    let previousHeight = reservedHeight;
    const measure = () => {
      const nextHeight = host.getBoundingClientRect().height;
      if (nextHeight <= 0) return;
      heightCache.exact.set(cacheKey, nextHeight);
      heightCache.recent.set(pageNumber, nextHeight);
      if (Math.abs(nextHeight - previousHeight) > 1) {
        onMeasuredHeightChange(pageNumber, previousHeight, nextHeight);
      }
      previousHeight = nextHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [cacheKey, heightCache, isNearViewport, onMeasuredHeightChange, pageNumber, paragraphs, reservedHeight]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      setProximity({ document, near: entries.some((entry) => entry.isIntersecting) });
    }, { root, rootMargin: '100% 0px 100% 0px' });
    observer.observe(host);
    return () => observer.disconnect();
  }, [document, paragraphs, root]);

  useEffect(() => {
    if (!isNearViewport && paragraphs !== null) {
      setLoaded(null);
      onLayoutUnavailable(document, pageNumber);
    }
  }, [document, isNearViewport, onLayoutUnavailable, pageNumber, paragraphs]);

  useEffect(() => {
    if (!isNearViewport || prepared?.paragraphs !== undefined) return;
    let isActive = true;
    let measuredSize = fallbackPageSize;
    void document.getPage(pageNumber)
      .then(async (page) => {
        const viewport = page.getViewport({ scale: 1 });
        measuredSize = { width: viewport.width, height: viewport.height };
        const result = await readPdfPageText(page);
        if (isActive) {
          const paragraphs = result.paragraphs;
          setLoaded({ document, paragraphs, size: measuredSize });
          onLayoutReady(document, pageNumber, { kind: paragraphs.length ? 'text' : 'canvas', size: measuredSize, ready: true });
        }
      })
      .catch(() => {
        if (isActive) {
          onCheckUpdate?.();
          setLoaded({ document, paragraphs: [], size: measuredSize });
          onLayoutReady(document, pageNumber, { kind: 'canvas', size: measuredSize, ready: true });
        }
      });
    return () => { isActive = false; };
  }, [document, fallbackPageSize, isNearViewport, onCheckUpdate, onLayoutReady, pageNumber, prepared]);

  if (!isNearViewport || paragraphs === null) {
    return (
      <article className="pdf-reflow-placeholder mx-auto grid w-full max-w-[44rem] place-items-center text-xs" ref={hostRef} style={{ height: reservedHeight }}>
        {isNearViewport ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <span>{pageNumber}</span>}
      </article>
    );
  }

  if (!paragraphs.length) {
    const size = pageSize ?? fallbackPageSize;
    return (
      <article className="flex w-max min-w-full justify-center bg-[color:var(--reader-page)] py-2 sm:bg-transparent sm:py-0" ref={hostRef}>
        <PdfCanvasPage document={document} onRendered={onRendered} onRenderUnavailable={onRenderUnavailable} onCheckUpdate={onCheckUpdate} onRetry={onRetry} pageNumber={pageNumber} pageSize={size} pageWidth={calculatePdfFallbackWidth({ availableSize, pageSize: size, zoom: fallbackZoom })} root={root} />
      </article>
    );
  }

  return (
    <article className={cn('pdf-reflow-page mx-auto w-full max-w-[44rem] px-5 pb-12 pt-7 sm:px-12 sm:py-12', readerBodyFontClass[fontFamily])} ref={hostRef}>
      <div className="pdf-reflow-index mb-6 text-center text-[11px] tabular-nums">{pageNumber} / {pageCount}</div>
      <div className="pdf-reflow-text" style={{ fontSize }}>
        {paragraphs.map((paragraph, index) => <p dir="auto" key={`${pageNumber}-${index}`} style={{ textAlign: getAutoParagraphAlignment(paragraph) }}>{paragraph}</p>)}
      </div>
    </article>
  );
}

function PdfCanvasPage({ document, onCheckUpdate, onRetry, onRendered, onRenderUnavailable, pageNumber, pageSize, pageWidth, root }: { document: PDFDocumentProxy; onCheckUpdate?: () => void; onRetry?: (pageNumber: number) => void; onRendered?: (document: PDFDocumentProxy, pageNumber: number) => void; onRenderUnavailable?: (document: PDFDocumentProxy, pageNumber: number) => void; pageNumber: number; pageSize?: PdfPageSize; pageWidth: number; root: Element | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prepared = getPreparedPdfPage(document, pageNumber)?.frame;
  const [proximity, setProximity] = useState<{ document: PDFDocumentProxy; near: boolean } | null>(null);
  const isNearViewport = proximity?.document === document ? proximity.near : Boolean(prepared);
  const paintedRef = useRef<{ document: PDFDocumentProxy; width: number; canvas: HTMLCanvasElement } | null>(null);
  const [aspectRatio, setAspectRatio] = useState(1 / Math.sqrt(2));
  const [renderError, setRenderError] = useState(false);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!isNearViewport || !canvas || !prepared || Math.abs(prepared.pageWidth - pageWidth) > 0.5) return;
    try {
      paintPdfPageFrame(canvas, prepared);
      paintedRef.current = { document, width: pageWidth, canvas };
      setAspectRatio(prepared.size.width / prepared.size.height);
      setRenderError(false);
      onRendered?.(document, pageNumber);
    } catch {
      setRenderError(true);
      onCheckUpdate?.();
    }
  }, [document, isNearViewport, onCheckUpdate, onRendered, pageNumber, pageWidth, prepared]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      setProximity({ document, near: entries.some((entry) => entry.isIntersecting) });
    }, { root, rootMargin: '180% 0px 180% 0px' });
    observer.observe(host);
    return () => observer.disconnect();
  }, [document, root]);

  useEffect(() => {
    if (!isNearViewport) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let isActive = true;
    const controller = new AbortController();
    let renderedPage: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
    const alreadyPainted = paintedRef.current?.document === document && paintedRef.current.width === pageWidth && paintedRef.current.canvas === canvas;
    if (!alreadyPainted) void document.getPage(pageNumber).then(async (page) => {
      if (!isActive) return;
      renderedPage = page;
      const baseViewport = page.getViewport({ scale: 1 });
      setAspectRatio(baseViewport.width / baseViewport.height);
      const frame = await renderPdfPageFrame(page, pageWidth, controller.signal);
      try {
        if (!isActive) return;
        paintPdfPageFrame(canvas, frame);
        paintedRef.current = { document, width: pageWidth, canvas };
        setRenderError(false);
        onRendered?.(document, pageNumber);
      } finally { frame.canvas.width = 0; frame.canvas.height = 0; }
    }).catch((error: unknown) => {
      if (isActive && (!(error instanceof Error) || error.name !== 'RenderingCancelledException')) { onRenderUnavailable?.(document, pageNumber); setRenderError(true); onCheckUpdate?.(); }
    });
    return () => {
      isActive = false;
      // A zoom can keep the previous bitmap readable while its replacement
      // renders. Only a removed or different-document surface becomes unavailable.
      if (!canvas.isConnected || !canvas.width || paintedRef.current?.document !== document) onRenderUnavailable?.(document, pageNumber);
      controller.abort();
      if (!canvas.isConnected) {
        canvas.width = 0;
        canvas.height = 0;
      }
      renderedPage?.cleanup();
    };
  }, [document, isNearViewport, onCheckUpdate, onRendered, onRenderUnavailable, pageNumber, pageWidth]);

  const hostStyle = { aspectRatio: pageSize ? pageSize.width / pageSize.height : aspectRatio, width: pageWidth } satisfies CSSProperties;
  return (
    <div className="pdf-canvas-page relative overflow-hidden shadow-[0_10px_36px_rgba(0,0,0,0.24)]" ref={hostRef} style={hostStyle}>
      {isNearViewport && <canvas aria-label={`PDF 第 ${pageNumber} 页`} className="block h-full w-full" ref={canvasRef} />}
      {isNearViewport && !renderError && <PdfTextLayer document={document} pageNumber={pageNumber} pageWidth={pageWidth} />}
      {!isNearViewport && <div className="absolute inset-0 animate-pulse" />}
      {renderError && <div className="absolute inset-0 grid place-items-center bg-[color:var(--reader-page)] px-4 text-center text-xs text-[color:var(--reader-muted)]"><div><p>第 {pageNumber} 页渲染失败</p>{onRetry && <button className="mt-3 rounded-md border border-[color:var(--reader-hairline)] px-3 py-2 text-[color:var(--reader-ink)] transition hover:bg-current/10" onClick={(event) => { event.stopPropagation(); onRetry(pageNumber); }} type="button">重试第 {pageNumber} 页</button>}</div></div>}
    </div>
  );
}

function IconButton({ children, className, disabled = false, label, onClick, buttonRef }: { children: ReactNode; className?: string; disabled?: boolean; label: string; onClick: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  return <button aria-label={label} aria-disabled={disabled} ref={buttonRef} className={cn('pointer-events-auto grid h-[44px] w-[44px] shrink-0 place-items-center rounded-md transition hover:bg-white/10 hover:text-[color:var(--reader-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--reader-accent)] aria-disabled:cursor-not-allowed aria-disabled:opacity-30', className)} onClick={() => { if (!disabled) onClick(); }} title={label} type="button">{children}</button>;
}

function PdfToolsPanel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const panelRef = useReaderPanelDismiss({ onClose });
  const viewportRef = useDialogViewport();
  return <div ref={viewportRef} className="viewport-dialog fixed z-50 flex items-end justify-center bg-black/30 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" onClick={onClose}>
    <section aria-label="更多阅读工具" aria-modal="true" className="reader-theme-dark max-h-full w-full max-w-sm overflow-y-auto overscroll-contain rounded-2xl bg-[color:var(--reader-page)] p-4 text-[color:var(--reader-ink)] shadow-xl outline-none reader-scrollbar" onClick={(event) => event.stopPropagation()} ref={panelRef} role="dialog" tabIndex={-1}>
      <div className="mb-2 flex items-center justify-between"><h2 className="text-sm">阅读工具</h2><IconButton label="关闭阅读工具" onClick={onClose}><X className="h-4 w-4" /></IconButton></div>
      {children}
    </section>
  </div>;
}
