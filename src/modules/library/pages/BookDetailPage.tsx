import { hasBookReadingHistory } from '../../books/services/bookProgress';
import { AlertCircle, BookOpen, Camera, CheckCircle2, ChevronLeft, Clock3, Download, Ellipsis, ExternalLink, FileUp, Globe2, Heart, ImagePlus, Link2, LoaderCircle, Pause, Pencil, Play, Plus, RotateCcw, Share2, Sparkles, ThumbsDown, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useSession } from '../../../app/SessionContext';
import { getChapterMutationErrorMessage } from '../../books/services/chapterMutationRequest';
import { createCollectionLinkState, getCollectionReturn, getCollectionReturnLabel } from '../../../shared/navigation/navigationState';
import { ROUTES } from '../../../config/routes';
import { Button } from '../../../shared/components/Button';
import { EmptyState } from '../../../shared/components/EmptyState';
import { LinkButton } from '../../../shared/components/LinkButton';
import { Panel } from '../../../shared/components/Panel';
import { ProgressBar } from '../../../shared/components/ProgressBar';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { HAIRLINE, LABEL } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';
import { isAbortError } from '../../../shared/utils/abortError';
import { startPolling } from '../../../shared/utils/polling';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { formatDate, parseAppDate } from '../../../shared/utils/formatDate';
import { formatFileSize } from '../../../shared/utils/formatFileSize';
import { BookCover, BookTags, CoverAmbientBackdrop, acknowledgeBookSourceUpdate, appendBookChapter, cancelBookPublicShare, checkBookSourceUpdate, deleteBook, deleteBookChapter, downloadOriginalBookFile, getBookById, getBrowserReaderAvailability, getEditableBookChapter, getEditableBookChapters, getReaderRouteForBook, invalidateBookListCache, kindLabel, removeCustomBookCover, requestBookPublicShare, setBookDisliked, setBookFavorite, setBookReadingCompletion, syncBookSourceCatalog, translateBookSourceUpdates, updateBook, updateBookChapter, uploadBookCover } from '../../books';
import type { Book } from '../../books';
import type { AppendBookChapterInput, BookPublicShareInput, BookUpdateInput, EditableBookChapterContent } from '../../books/services/bookService';
import { PublicCommentsPanel } from '../../comments/PublicCommentsPanel';
import { PUBLIC_COMMENTS_CHANGED_EVENT } from '../../comments/commentService';
import { getReaderResource, getReadingProgress, resetReaderChapterCache } from '../../reader/services/readerService';
import { READING_PROGRESS_SAVED_EVENT } from '../../reading-progress';
import type { ReaderResource, ReadingProgress } from '../../reader/types/reader';
import { BookEditDialog } from '../components/BookEditDialog';
import { BookCoverDialog } from '../components/BookCoverDialog';
import { AppendChapterDialog } from '../components/AppendChapterDialog';
import { EditChapterDialog } from '../components/EditChapterDialog';
import { SourceLinkDialog } from '../components/SourceLinkDialog';
import { TranslationDraftReviewDialog } from '../components/TranslationDraftReviewDialog';
import { ReplaceBookFileDialog } from '../components/ReplaceBookFileDialog';
import { BookDetailCatalog } from '../components/BookDetailCatalog';
import { DeleteBookDialog } from '../components/DeleteBookDialog';
import { BookSeriesPanel } from '../components/BookSeriesPanel';
import { SectionHeader } from '../components/SectionHeader';
import { getBookReadingStatus, type BookReadingStatus, type BookReadingStatusTone } from '../services/bookReadingStatus';
import { getBookSeriesShelf } from '../services/bookSeries';
import { getSeriesBookCandidates } from '../services/seriesBookCandidates';
import { resolveActiveChapterIndex, resolveActivePageIndex } from '../services/catalogStatus';
import { getBookTitleLayoutClass } from '../services/bookTitleLayout';
import { applyBookReadingCompletion, mergeBookActionResult, type BookActionKind } from '../services/bookActionResult';
import { useBookMenuPosition } from '../../books/hooks/useBookMenuPosition';
import { useBookReadingProgress } from '../hooks/useBookReadingProgress';
import { focusBookMenuItem } from '../../books/services/bookMenuPosition';
import { canEditBookChapters, createBookPublicationRefresher, getBookPublicationKey, getBookPublicationSnapshot, type BookPublicationState } from '../services/bookPublicationRefresh';
import { replaceBookFile, reprocessUploadedBook } from '../../uploads';
import { clearPendingReplacement, readPendingReplacement, savePendingReplacement } from '../services/bookFileReplacementState';
import { waitForUploadTask } from '../../uploads/services/uploadTaskObservation';
import { acceptSourceUpdateTranslation, getBookTranslationJobs, selectBookTranslationJob, getSourceUpdateTranslationReview, getWholeBookTranslationQualityMessage, getWholeBookTranslationStatusLabel, getWholeBookTranslationStatusMessage, pauseWholeBookTranslation, rejectSourceUpdateTranslation, resumeWholeBookTranslation, retryWholeBookTranslation, TRANSLATED_BOOKS_CHANGED_EVENT, TRANSLATION_JOBS_CHANGED_EVENT, updateWholeBookTranslationConcurrency, type SourceUpdateTranslationReview, type WholeBookTranslationJob } from '../../uploads/services/wholeBookTranslationService';

type BookTranslationAction = 'concurrency' | 'pause' | 'resume' | 'retry';
type CatalogSection = 'resource' | 'chapters' | 'progress';
type CatalogLoadState = 'loading' | 'ready' | 'failed';

export function BookDetailPage() {
  const { session } = useSession();
  const { bookId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationState = createCollectionLinkState(location);
  const collectionReturn = getCollectionReturn(location.state);
  const [searchParams, setSearchParams] = useSearchParams();
  const [result, setResult] = useState<{ book: Book | null; bookId: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [isDetailContentReady, setIsDetailContentReady] = useState(false);
  const [hasPublicationRefreshError, setHasPublicationRefreshError] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [favoriteError, setFavoriteError] = useState('');
  const [dislikeError, setDislikeError] = useState('');
  const [readingStatusError, setReadingStatusError] = useState('');
  const [reprocessError, setReprocessError] = useState('');
  const [replaceError, setReplaceError] = useState('');
  const [publicShareError, setPublicShareError] = useState('');
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [readerResource, setReaderResource] = useState<ReaderResource | null>(null);
  const [readingProgress, setReadingProgress] = useState<ReadingProgress | null>(null);
  const displayedReadingProgress = useBookReadingProgress(bookId, session?.id, readerResource, readingProgress);
  const [shareMessage, setShareMessage] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [editError, setEditError] = useState('');
  const [coverError, setCoverError] = useState('');
  const [appendError, setAppendError] = useState('');
  const [isAppendDialogOpen, setIsAppendDialogOpen] = useState(false);
  const [isAppendingChapter, setIsAppendingChapter] = useState(false);
  const [appendSuccess, setAppendSuccess] = useState<{ index: number; title: string } | null>(null);
  const [editableChapterIndexes, setEditableChapterIndexes] = useState<Set<number>>(new Set());
  const [catalogLoadState, setCatalogLoadState] = useState<CatalogLoadState>('loading');
  const [chapterToolsLoadState, setChapterToolsLoadState] = useState<CatalogLoadState>('loading');
  const [progressLoadState, setProgressLoadState] = useState<CatalogLoadState>('loading');
  const [editingChapterIndex, setEditingChapterIndex] = useState<number | null>(null);
  const [chapterBeingEdited, setChapterBeingEdited] = useState<EditableBookChapterContent | null>(null);
  const [chapterEditError, setChapterEditError] = useState('');
  const [isSavingChapterEdit, setIsSavingChapterEdit] = useState(false);
  const [chapterRefresh, setChapterRefresh] = useState<{ message: string; status: 'loading' | 'failed' } | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isCoverDialogOpen, setIsCoverDialogOpen] = useState(false);
  const [isSourceDialogOpen, setIsSourceDialogOpen] = useState(false);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isSavingCover, setIsSavingCover] = useState(false);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [isReplaceDialogOpen, setIsReplaceDialogOpen] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const [replaceProgress, setReplaceProgress] = useState(0);
  const [isCheckingSource, setIsCheckingSource] = useState(false);
  const [isAcknowledgingSource, setIsAcknowledgingSource] = useState(false);
  const [isTranslatingSource, setIsTranslatingSource] = useState(false);
  const [sourceUpdateError, setSourceUpdateError] = useState('');
  const [isUpdatingPublicShare, setIsUpdatingPublicShare] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isUpdatingFavorite, setIsUpdatingFavorite] = useState(false);
  const [isUpdatingDisliked, setIsUpdatingDisliked] = useState(false);
  const [isUpdatingReadingStatus, setIsUpdatingReadingStatus] = useState(false);
  const [areCommentsVisible, setAreCommentsVisible] = useState(readCommentsVisibilityPreference);
  const [isDeleting, setIsDeleting] = useState(false);
  const [translationReview, setTranslationReview] = useState<SourceUpdateTranslationReview | null>(null);
  const [translationReviewError, setTranslationReviewError] = useState('');
  const [translationReviewAction, setTranslationReviewAction] = useState<'accept' | 'reject' | null>(null);
  const [bookTranslationJob, setBookTranslationJob] = useState<WholeBookTranslationJob | null>(null);
  const [translationActionError, setTranslationActionError] = useState('');
  const [translationJobAction, setTranslationJobAction] = useState<BookTranslationAction | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [shareDraft, setShareDraft] = useState<BookPublicShareInput>({
    publicDownloadAllowed: false,
    shareNote: '',
    sourceNote: '',
  });
  const translationJobsRevisionRef = useRef(0);
  const translationJobsRequestRef = useRef(0);
  const translationActionControllerRef = useRef<AbortController | null>(null);
  const readingMutationRevisionRef = useRef(0);
  const replacementObservationRef = useRef<AbortController | null>(null);
  const sourceActionControllerRef = useRef<AbortController | null>(null);
  const viewActionControllersRef = useRef(new Set<AbortController>());
  const chapterLoadControllerRef = useRef<AbortController | null>(null);
  const chapterMutationControllerRef = useRef<AbortController | null>(null);
  const chapterRefreshControllerRef = useRef<AbortController | null>(null);
  const chapterRefreshFocusRef = useRef(false);
  const currentViewRef = useRef({ bookId, sessionId: session?.id });
  const detailMutationRevisionRef = useRef(0);
  const catalogRequestsRef = useRef(new Map<CatalogSection, AbortController>());
  const catalogRootRef = useRef<HTMLDivElement>(null);
  const progressRootRef = useRef<HTMLDivElement>(null);
  const catalogRetryFocusRef = useRef<CatalogSection | null>(null);
  const loadCatalogSection = useCallback(async (section: CatalogSection) => {
    const requests = catalogRequestsRef.current;
    if (requests.has(section)) return;
    const controller = new AbortController();
    requests.set(section, controller);
    const setLoadState = section === 'resource' ? setCatalogLoadState : section === 'chapters' ? setChapterToolsLoadState : setProgressLoadState;
    const readingRevision = readingMutationRevisionRef.current;
    const isCurrent = () => !controller.signal.aborted && requests.get(section) === controller
      && currentViewRef.current.bookId === bookId && currentViewRef.current.sessionId === session?.id
      && (section !== 'progress' || readingRevision === readingMutationRevisionRef.current);
    setLoadState('loading');
    try {
      if (section === 'resource') {
        const resource = await getReaderResource(bookId, controller.signal);
        if (isCurrent()) setReaderResource(resource);
      } else if (section === 'chapters') {
        const chapters = await getEditableBookChapters(bookId, controller.signal);
        if (isCurrent()) setEditableChapterIndexes(new Set(chapters.map((chapter) => chapter.index)));
      } else {
        const progress = await getReadingProgress(bookId, controller.signal);
        if (isCurrent()) setReadingProgress(progress);
      }
      if (isCurrent()) setLoadState('ready');
    } catch {
      if (isCurrent()) setLoadState('failed');
    } finally {
      if (requests.get(section) === controller) requests.delete(section);
    }
  }, [bookId, session?.id]);
  useLayoutEffect(() => {
    const section = catalogRetryFocusRef.current;
    if (!section) return;
    const state = section === 'resource' ? catalogLoadState : section === 'chapters' ? chapterToolsLoadState : progressLoadState;
    if (state === 'loading') return;
    catalogRetryFocusRef.current = null;
    const root = section === 'progress' ? progressRootRef.current : catalogRootRef.current;
    if (document.activeElement !== document.body && !root?.contains(document.activeElement)) return;
    const selector = state === 'failed'
      ? section === 'resource' ? '.book-detail-catalog-error button' : section === 'chapters' ? '.book-detail-chapter-tools-status button' : '.book-detail-progress-status button'
      : section === 'chapters' ? '[aria-label^="编辑"]' : '.book-detail-catalog-content a';
    (section === 'progress' && state === 'ready' ? root : root?.querySelector<HTMLElement>(selector) ?? root)?.focus({ preventScroll: true });
  }, [catalogLoadState, chapterToolsLoadState, progressLoadState]);
  const publicationStateRef = useRef<BookPublicationState>({ bookId, sessionId: session?.id, book: null, readerResource: null, ready: false, busy: false, mutationRevision: 0, job: null });
  useLayoutEffect(() => {
    const currentBook = result?.book;
    const needsChapterTools = currentBook && canEditBookChapters(currentBook);
    publicationStateRef.current = {
      bookId, sessionId: session?.id, book: result?.book ?? null, readerResource,
      ready: isDetailContentReady, busy: Boolean(chapterRefresh) || progressLoadState !== 'ready' || catalogLoadState !== 'ready' || Boolean(needsChapterTools && chapterToolsLoadState !== 'ready'), mutationRevision: detailMutationRevisionRef.current, job: bookTranslationJob,
    };
  });
  const publicationRefresherRef = useRef<ReturnType<typeof createBookPublicationRefresher> | null>(null);
  useEffect(() => {
    const refresher = createBookPublicationRefresher(
      { bookId, sessionId: session?.id },
      () => ({ ...publicationStateRef.current, mutationRevision: detailMutationRevisionRef.current, busy: publicationStateRef.current.busy || chapterRefreshControllerRef.current !== null || viewActionControllersRef.current.size > 0 || sourceActionControllerRef.current !== null || catalogRequestsRef.current.size > 0 }),
      (snapshot) => {
        setResult({ book: snapshot.book, bookId });
        setReaderResource(snapshot.readerResource);
        setReadingProgress(snapshot.readingProgress);
        setProgressLoadState('ready');
        setEditableChapterIndexes(snapshot.editableChapterIndexes);
        setCatalogLoadState('ready');
        setChapterToolsLoadState('ready');
        setAllBooks((current) => current.map((candidate) => candidate.id === bookId ? snapshot.book : candidate));
      },
      setHasPublicationRefreshError,
    );
    publicationRefresherRef.current = refresher;
    return () => { publicationRefresherRef.current = null; };
  }, [bookId, session?.id]);
  const publicationJobKey = getBookPublicationKey(bookTranslationJob);

  useEffect(() => {
    const publicationRefresher = publicationRefresherRef.current;
    if (!publicationRefresher) return;
    const invalidate = () => publicationRefresher.invalidate();
    window.addEventListener(TRANSLATED_BOOKS_CHANGED_EVENT, invalidate);
    window.addEventListener(READING_PROGRESS_SAVED_EVENT, invalidate);
    const stop = startPolling((signal) => publicationRefresher.refresh(signal), {
      intervalMs: 4000,
      onResume: invalidate,
      events: ['focus', TRANSLATED_BOOKS_CHANGED_EVENT, READING_PROGRESS_SAVED_EVENT],
    });
    return () => {
      stop();
      window.removeEventListener(TRANSLATED_BOOKS_CHANGED_EVENT, invalidate);
      window.removeEventListener(READING_PROGRESS_SAVED_EVENT, invalidate);
    };
  }, [bookId, session?.id, publicationJobKey, isDetailContentReady]);

  const cancelPendingChapterLoad = useCallback(() => {
    if (!chapterLoadControllerRef.current) return;
    chapterLoadControllerRef.current.abort();
    chapterLoadControllerRef.current = null;
    setEditingChapterIndex(null);
  }, []);

  const beginViewAction = () => {
    detailMutationRevisionRef.current += 1;
    const controller = new AbortController();
    viewActionControllersRef.current.add(controller);
    return { controller, bookId, sessionId: session?.id };
  };

  const isCurrentViewAction = (action: { controller: AbortController; bookId: string; sessionId?: string }) => (
    !action.controller.signal.aborted
    && currentViewRef.current.bookId === action.bookId
    && currentViewRef.current.sessionId === action.sessionId
  );

  const finishViewAction = (action: { controller: AbortController }) => {
    viewActionControllersRef.current.delete(action.controller);
  };

  const refreshConfirmedChapters = async (message: string) => {
    if (chapterRefreshControllerRef.current) return;
    const controller = new AbortController();
    chapterRefreshControllerRef.current = controller;
    readingMutationRevisionRef.current += 1;
    const revision = detailMutationRevisionRef.current;
    const isCurrent = () => !controller.signal.aborted && chapterRefreshControllerRef.current === controller
      && currentViewRef.current.bookId === bookId && currentViewRef.current.sessionId === session?.id;
    cancelPendingChapterLoad();
    catalogRequestsRef.current.forEach((request) => request.abort());
    catalogRequestsRef.current.clear();
    catalogRetryFocusRef.current = null;
    chapterRefreshFocusRef.current = true;
    setHasPublicationRefreshError(false);
    setChapterRefresh({ message, status: 'loading' });
    try {
      const nextBook = await getBookById(bookId, controller.signal);
      if (!isCurrent()) return;
      if (!nextBook) throw new Error('图书信息暂时无法读取');
      const snapshot = await getBookPublicationSnapshot(nextBook, controller.signal);
      if (!isCurrent()) return;
      if (revision !== detailMutationRevisionRef.current) throw new Error('图书信息已更新，请重新核对');
      setResult({ book: snapshot.book, bookId });
      setReaderResource(snapshot.readerResource);
      setReadingProgress(snapshot.readingProgress);
      setProgressLoadState('ready');
      setEditableChapterIndexes(snapshot.editableChapterIndexes);
      setCatalogLoadState('ready');
      setChapterToolsLoadState('ready');
      setIsDetailContentReady(true);
      setAllBooks((current) => current.map((candidate) => candidate.id === bookId ? snapshot.book : candidate));
      setChapterRefresh(null);
    } catch {
      if (isCurrent()) setChapterRefresh({ message, status: 'failed' });
    } finally {
      if (chapterRefreshControllerRef.current === controller) chapterRefreshControllerRef.current = null;
    }
  };

  useEffect(() => {
    if (!chapterRefreshFocusRef.current) return;
    const frame = requestAnimationFrame(() => {
      const root = catalogRootRef.current;
      if (document.querySelector('[role="dialog"]') || (document.activeElement !== document.body && !root?.contains(document.activeElement))) return;
      const target = chapterRefresh?.status === 'failed' ? '.book-detail-chapter-refresh button'
        : chapterRefresh ? '.book-detail-chapter-refresh' : '.book-detail-catalog-content a';
      (root?.querySelector<HTMLElement>(target) ?? root)?.focus({ preventScroll: true });
    });
    if (!chapterRefresh) chapterRefreshFocusRef.current = false;
    return () => cancelAnimationFrame(frame);
  }, [chapterRefresh]);

  const refreshBookTranslationJob = useCallback(async (signal?: AbortSignal) => {
    const expectedSessionId = session?.id;
    const revision = translationJobsRevisionRef.current;
    const requestId = ++translationJobsRequestRef.current;
    try {
      const jobs = await getBookTranslationJobs(bookId, signal);
      if (
        signal?.aborted
        || currentViewRef.current.bookId !== bookId
        || currentViewRef.current.sessionId !== expectedSessionId
      ) return;
      if (requestId !== translationJobsRequestRef.current || translationActionControllerRef.current) return;
      if (revision !== translationJobsRevisionRef.current) {
        window.dispatchEvent(new Event(TRANSLATION_JOBS_CHANGED_EVENT));
        return;
      }
      const job = selectBookTranslationJob(jobs, bookId);
      setBookTranslationJob(job ?? null);
    } catch (error: unknown) {
      if (isAbortError(error)) return;
    }
  }, [bookId, session?.id]);

  useEffect(() => {
    currentViewRef.current = { bookId, sessionId: session?.id };
    translationJobsRevisionRef.current += 1;
    translationJobsRequestRef.current += 1;
    translationActionControllerRef.current = null;
    setBookTranslationJob(null);
    setTranslationActionError('');
    setHasPublicationRefreshError(false);
    setTranslationReviewAction(null);
    setTranslationJobAction(null);
    setIsUpdatingPublicShare(false);
    setIsUpdatingFavorite(false);
    setIsUpdatingDisliked(false);
    setIsUpdatingReadingStatus(false);
    setIsAppendingChapter(false);
    setChapterRefresh(null);
    chapterRefreshFocusRef.current = false;
    setChapterBeingEdited(null);
    setIsAppendDialogOpen(false);
    setChapterEditError('');
    setAppendError('');
    setShareMessage('');
    setEditingChapterIndex(null);
    setIsSavingChapterEdit(false);
    setIsSavingEdit(false);
    setIsReprocessing(false);
    setIsSavingCover(false);
    setIsDeleting(false);
    setIsReplacing(false);
    setReplaceProgress(0);
  }, [bookId, session?.id]);

  useEffect(() => {
    return startPolling(refreshBookTranslationJob, {
      intervalMs: 4000,
      events: [TRANSLATION_JOBS_CHANGED_EVENT],
    });
  }, [refreshBookTranslationJob]);

  useEffect(() => {
    setAppendSuccess(null);
  }, [bookId, session?.id]);

  useEffect(() => {
    const handleCommentChange = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId: string; delta: number }>).detail;
      if (!detail || detail.bookId !== bookId || currentViewRef.current.sessionId !== session?.id) return;
      detailMutationRevisionRef.current += 1;
      setResult((current) => current?.book && current.bookId === bookId
        ? { ...current, book: { ...current.book, commentCount: Math.max(0, (current.book.commentCount ?? 0) + detail.delta) } } : current);
    };
    window.addEventListener(PUBLIC_COMMENTS_CHANGED_EVENT, handleCommentChange);
    return () => window.removeEventListener(PUBLIC_COMMENTS_CHANGED_EVENT, handleCommentChange);
  }, [bookId, session?.id]);

  useEffect(() => {
    sourceActionControllerRef.current?.abort();
    sourceActionControllerRef.current = null;
    const viewActionControllers = viewActionControllersRef.current;
    setIsDownloading(false);
    setDownloadError('');
    setIsCheckingSource(false);
    setIsAcknowledgingSource(false);
    setIsTranslatingSource(false);
    return () => {
      sourceActionControllerRef.current?.abort();
      sourceActionControllerRef.current = null;
      viewActionControllers.forEach((controller) => controller.abort());
      viewActionControllers.clear();
      chapterLoadControllerRef.current = null;
      chapterMutationControllerRef.current = null;
      chapterRefreshControllerRef.current?.abort();
      chapterRefreshControllerRef.current = null;
    };
  }, [bookId, session?.id]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const catalogRequests = catalogRequestsRef.current;
    setIsDetailContentReady(false);
    setResult(null);
    setAllBooks([]);
    setReaderResource(null);
    setReadingProgress(null);
    setEditableChapterIndexes(new Set());
    setChapterToolsLoadState('loading');
    setLoadError('');
    const bookRequest = getBookById(bookId, controller.signal)
      .then(async (nextBook) => {
        if (!active || controller.signal.aborted) return;
        setResult({ book: nextBook, bookId });
        if (!nextBook) {
          setAllBooks([]);
          setChapterToolsLoadState('ready');
          return;
        }
        void getSeriesBookCandidates(nextBook, controller.signal)
          .then((books) => { if (active && !controller.signal.aborted) setAllBooks(books); })
          .catch(() => { if (!controller.signal.aborted && active) setAllBooks([]); });
        if (canEditBookChapters(nextBook)) await loadCatalogSection('chapters');
        else setChapterToolsLoadState('ready');
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        // Only a backend 404 resolves to null; anything else (network, 5xx)
        // lands here and gets a retryable error state instead of a fake 404.
        setLoadError(error instanceof Error && error.message ? error.message : '图书详情加载失败');
      });
    const resourceRequest = loadCatalogSection('resource');
    const progressRequest = loadCatalogSection('progress');
    void Promise.allSettled([bookRequest, resourceRequest, progressRequest]).then(() => {
      if (active && !controller.signal.aborted) setIsDetailContentReady(true);
    });
    return () => {
      active = false;
      controller.abort();
      catalogRequests.forEach((request) => request.abort());
      catalogRequests.clear();
      catalogRetryFocusRef.current = null;
    };
  }, [bookId, detailReloadKey, loadCatalogSection, session?.id]);

  useEffect(() => {
    replacementObservationRef.current?.abort();
    replacementObservationRef.current = null;
    const pendingReplacement = readPendingReplacement(bookId);
    if (!pendingReplacement) return undefined;
    const controller = new AbortController();
    replacementObservationRef.current = controller;
    setShareMessage('检测到未确认的替换任务，正在继续核对…');
    void waitForUploadTask(pendingReplacement.taskId, controller.signal)
      .then((task) => {
        if (controller.signal.aborted) return;
        if (task.status === 'failed') {
          clearPendingReplacement(bookId);
          setShareMessage(task.message || '替换任务失败，旧版本已保留');
        } else if (task.status === 'ready') {
          clearPendingReplacement(bookId);
          setShareMessage(pendingReplacement.keepProgress ? '替换完成，阅读时长和百分比进度已保留' : '替换完成，阅读时长已保留，阅读位置已重置');
          setDetailReloadKey((key) => key + 1);
        } else {
          setShareMessage('服务器仍在处理替换任务，可稍后返回或前往上传页面查看进度。');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setShareMessage('替换结果暂时无法确认，请稍后返回或前往上传页面查看进度。');
      })
      .finally(() => {
        if (replacementObservationRef.current === controller) replacementObservationRef.current = null;
      });
    return () => {
      controller.abort();
      if (replacementObservationRef.current === controller) replacementObservationRef.current = null;
    };
  }, [bookId, session?.id]);

  const translationReviewJobId = searchParams.get('translationReview');
  const translationReviewControllerRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setTranslationReviewAction(null);
    return () => {
      translationReviewControllerRef.current?.abort();
      translationReviewControllerRef.current = null;
    };
  }, [bookId, session?.id, translationReviewJobId]);

  const isCurrentTranslationReviewAction = (action: { controller: AbortController; bookId: string; sessionId?: string }) => (
    translationReviewControllerRef.current === action.controller && isCurrentViewAction(action)
  );

  useEffect(() => {
    if (!translationReviewJobId) {
      setTranslationReview(null);
      setTranslationReviewError('');
      return;
    }
    const controller = new AbortController();
    setTranslationReview(null);
    setTranslationReviewError('');
    void getSourceUpdateTranslationReview(translationReviewJobId, controller.signal)
      .then((review) => {
        if (controller.signal.aborted) return;
        if (review.book_id !== bookId) throw new Error('这份译稿不属于当前图书');
        setTranslationReview(review);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : '更新译稿加载失败';
        setTranslationReviewError(message);
        setShareMessage(message);
        setSearchParams((current) => {
          const next = new URLSearchParams(current);
          next.delete('translationReview');
          return next;
        }, { replace: true, state: location.state });
      });
    return () => { controller.abort(); };
  }, [bookId, session?.id, location.state, setSearchParams, translationReviewJobId]);

  const closeTranslationReview = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('translationReview');
    setSearchParams(next, { replace: true, state: location.state });
    setTranslationReview(null);
    setTranslationReviewError('');
  };

  const handleAcceptTranslationReview = async () => {
    if (!translationReview || translationReviewControllerRef.current) return;
    const action = beginViewAction();
    translationReviewControllerRef.current = action.controller;
    translationJobsRevisionRef.current += 1;
    setTranslationReviewError('');
    setTranslationReviewAction('accept');
    try {
      const acceptedJob = await acceptSourceUpdateTranslation(translationReview.job_id, action.controller.signal);
      if (!isCurrentTranslationReviewAction(action)) return;
      translationJobsRevisionRef.current += 1;
      closeTranslationReview();
      void refreshBookTranslationJob();
      resetReaderChapterCache();
      setShareMessage(acceptedJob.status === 'ready'
        ? `已将 ${translationReview.chapters.length} 话更新译文写入原书`
        : acceptedJob.message || '译稿已确认，正在准备发布；完成后会更新原书');
      setDetailReloadKey((key) => key + 1);
    } catch (error: unknown) {
      if (isCurrentTranslationReviewAction(action)) setTranslationReviewError(error instanceof Error ? error.message : '译稿确认失败，请重试');
    } finally {
      finishViewAction(action);
      if (translationReviewControllerRef.current === action.controller) {
        translationReviewControllerRef.current = null;
        if (isCurrentViewAction(action)) setTranslationReviewAction(null);
      }
    }
  };

  const handleRejectTranslationReview = async () => {
    if (!translationReview || translationReviewControllerRef.current) return;
    if (!window.confirm(`放弃《${translationReview.title}》这批更新译稿吗？\n\n原书不会修改，译稿会被删除。`)) return;
    const action = beginViewAction();
    translationReviewControllerRef.current = action.controller;
    translationJobsRevisionRef.current += 1;
    setTranslationReviewError('');
    setTranslationReviewAction('reject');
    try {
      await rejectSourceUpdateTranslation(translationReview.job_id, action.controller.signal);
      if (!isCurrentTranslationReviewAction(action)) return;
      translationJobsRevisionRef.current += 1;
      closeTranslationReview();
      void refreshBookTranslationJob();
      setShareMessage('已放弃这批更新译稿，原书未修改');
      setDetailReloadKey((key) => key + 1);
    } catch (error: unknown) {
      if (isCurrentTranslationReviewAction(action)) setTranslationReviewError(error instanceof Error ? error.message : '放弃译稿失败');
    } finally {
      finishViewAction(action);
      if (translationReviewControllerRef.current === action.controller) {
        translationReviewControllerRef.current = null;
        if (isCurrentViewAction(action)) setTranslationReviewAction(null);
      }
    }
  };

  const book = result?.bookId === bookId ? result.book : undefined;
  const seriesShelf = useMemo(() => {
    if (!book) {
      return null;
    }

    const books = allBooks.some((candidate) => candidate.id === book.id) ? allBooks.map((candidate) => (candidate.id === book.id ? book : candidate)) : [...allBooks, book];
    return getBookSeriesShelf(book, books);
  }, [allBooks, book]);

  if (loadError) {
    return (
      <EmptyState
        action={<Button onClick={() => setDetailReloadKey((currentKey) => currentKey + 1)}>重试</Button>}
        description={loadError}
        title="图书加载失败"
      />
    );
  }

  if (book === null) {
    return <EmptyState title="没有找到图书" />;
  }

  if (book === undefined) {
    return (
      <div className="animate-pulse space-y-8" data-navigation-loading="true">
        <div className="relative overflow-hidden border-y border-stone-900/5 bg-stone-900/[0.03] px-5 py-8 sm:px-8 sm:py-10 lg:px-10 dark:border-white/[0.05] dark:bg-white/[0.03]">
          <div className="mb-6 h-5 w-24 rounded-full bg-stone-900/10 dark:bg-stone-800" />
          <div className="grid gap-8 md:grid-cols-[210px_minmax(0,1fr)] md:gap-8 lg:grid-cols-[230px_1fr] lg:gap-10">
            <div className="h-[310px] w-[190px] rounded-2xl bg-stone-900/10 sm:w-[210px] dark:bg-stone-800" />
            <div className="min-w-0 space-y-4 py-2">
              <div className="flex gap-2">
                <div className="h-6 w-16 rounded-full bg-stone-900/10 dark:bg-stone-800" />
                <div className="h-6 w-16 rounded-full bg-stone-900/10 dark:bg-stone-800" />
              </div>
              <div className="h-10 w-3/4 rounded-2xl bg-stone-900/10 dark:bg-stone-800" />
              <div className="h-4 w-40 rounded-full bg-stone-900/10 dark:bg-stone-800" />
              <div className="grid max-w-xl grid-cols-2 gap-x-10 gap-y-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div className="h-6 rounded bg-stone-900/10 dark:bg-stone-800" key={index} />
                ))}
              </div>
              <div className="mt-6 flex gap-3">
                <div className="h-11 w-32 rounded-2xl bg-stone-900/10 dark:bg-stone-800" />
                <div className="h-11 w-32 rounded-2xl bg-stone-900/10 dark:bg-stone-800" />
                <div className="h-11 w-32 rounded-2xl bg-stone-900/10 dark:bg-stone-800" />
              </div>
            </div>
          </div>
        </div>
        <div>
          <Panel className="space-y-6">
            <div className="h-8 w-24 rounded bg-stone-900/10 dark:bg-stone-800" />
            <div className="space-y-3">
              <div className="h-4 w-full rounded bg-stone-900/10 dark:bg-stone-800" />
              <div className="h-4 w-5/6 rounded bg-stone-900/10 dark:bg-stone-800" />
              <div className="h-4 w-4/5 rounded bg-stone-900/10 dark:bg-stone-800" />
            </div>
          </Panel>
        </div>
      </div>
    );
  }

  const readerAvailability = getBrowserReaderAvailability(book, readerResource);
  const currentProgressPercent = displayedReadingProgress?.progressPercent ?? book.progressPercent;
  const hasKnownReadingPosition = progressLoadState === 'ready' || Boolean(displayedReadingProgress);
  const activeChapterIndex = hasKnownReadingPosition && readerResource && 'toc' in readerResource
    ? resolveActiveChapterIndex({
      chapterCount: readerResource.chapterCount,
      progressPercent: currentProgressPercent,
      savedChapterIndex: displayedReadingProgress?.chapterIndex,
    })
    : null;
  const activePageIndex = hasKnownReadingPosition && readerResource && 'pages' in readerResource
    ? resolveActivePageIndex({
      pageCount: readerResource.pageCount || readerResource.pages.length,
      progressPercent: currentProgressPercent,
      savedPageIndex: displayedReadingProgress?.imageIndex ?? displayedReadingProgress?.pageNumber,
    })
    : null;
  const catalogProgressPercent = currentProgressPercent;
  const readingStatus = getBookReadingStatus(book, readerResource, readerAvailability, catalogLoadState === 'failed');
  const isFinished = currentProgressPercent >= 100;
  const isPublicBook = book.publicStatus === 'public';
  const isOwnedBook = book.isOwned !== false;
  const canDownloadOriginal = Boolean(book.fileSize) && (isOwnedBook || book.publicDownloadAllowed !== false);
  const appendChapterCount = readerResource && 'chapterCount' in readerResource ? readerResource.chapterCount : (book.chapterCount ?? 0);
  const canAppendChapter = canEditBookChapters(book);

  const handleCommentsVisibilityChange = (nextValue: boolean) => {
    setAreCommentsVisible(nextValue);
    saveCommentsVisibilityPreference(nextValue);
  };

  const handleAppendChapter = async (input: AppendBookChapterInput) => {
    if (chapterMutationControllerRef.current || chapterRefreshControllerRef.current || chapterRefresh) return false;
    const action = beginViewAction();
    chapterMutationControllerRef.current = action.controller;
    setAppendError('');
    setIsAppendingChapter(true);
    try {
      const appended = await appendBookChapter(book.id, input, action.controller.signal);
      if (!isCurrentViewAction(action)) return true;
      setIsAppendDialogOpen(false);
      setAppendSuccess({ index: appended.index, title: appended.title });
      setShareMessage('');
      resetReaderChapterCache(book.id);
      void refreshConfirmedChapters(`已追加“${appended.title}”`);
      return true;
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setAppendError(getChapterMutationErrorMessage('追加', error));
      return false;
    } finally {
      finishViewAction(action);
      if (chapterMutationControllerRef.current === action.controller) chapterMutationControllerRef.current = null;
      if (isCurrentViewAction(action)) setIsAppendingChapter(false);
    }
  };

  const handleEditChapterRequest = async (chapterIndex: number) => {
    if (chapterMutationControllerRef.current || chapterRefreshControllerRef.current || chapterRefresh) return;
    cancelPendingChapterLoad();
    const action = beginViewAction();
    chapterLoadControllerRef.current = action.controller;
    setChapterEditError('');
    setEditingChapterIndex(chapterIndex);
    try {
      const chapter = await getEditableBookChapter(book.id, chapterIndex, action.controller.signal);
      if (!isCurrentViewAction(action) || chapterLoadControllerRef.current !== action.controller) return;
      setChapterBeingEdited(chapter);
    } catch (error: unknown) {
      if (isCurrentViewAction(action) && chapterLoadControllerRef.current === action.controller) setShareMessage(error instanceof Error ? error.message : '章节正文加载失败');
    } finally {
      finishViewAction(action);
      if (chapterLoadControllerRef.current === action.controller) {
        chapterLoadControllerRef.current = null;
        if (isCurrentViewAction(action)) setEditingChapterIndex(null);
      }
    }
  };

  const handleChapterEditSave = async (input: AppendBookChapterInput, revision: string) => {
    if (!chapterBeingEdited || chapterMutationControllerRef.current || chapterRefreshControllerRef.current || chapterRefresh) return false;
    const action = beginViewAction();
    chapterMutationControllerRef.current = action.controller;
    setChapterEditError('');
    setIsSavingChapterEdit(true);
    try {
      const updated = await updateBookChapter(book.id, chapterBeingEdited.index, input, action.controller.signal, revision);
      if (!isCurrentViewAction(action)) return true;
      resetReaderChapterCache(book.id);
      setChapterBeingEdited(null);
      setAppendSuccess(null);
      setShareMessage(`已将“${updated.title}”写入原书文件`);
      void refreshConfirmedChapters(`已将“${updated.title}”写入原书文件`);
      return true;
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setChapterEditError(getChapterMutationErrorMessage('保存', error));
      return false;
    } finally {
      finishViewAction(action);
      if (chapterMutationControllerRef.current === action.controller) chapterMutationControllerRef.current = null;
      if (isCurrentViewAction(action)) setIsSavingChapterEdit(false);
    }
  };

  const handleChapterDelete = async () => {
    if (!chapterBeingEdited || chapterMutationControllerRef.current || chapterRefreshControllerRef.current || chapterRefresh) return false;
    const action = beginViewAction();
    chapterMutationControllerRef.current = action.controller;
    setChapterEditError('');
    setIsSavingChapterEdit(true);
    try {
      const deleted = await deleteBookChapter(book.id, chapterBeingEdited.index, action.controller.signal, chapterBeingEdited.revision);
      if (!isCurrentViewAction(action)) return true;
      resetReaderChapterCache(book.id);
      setChapterBeingEdited(null);
      setAppendSuccess(null);
      setShareMessage(`已从原书删除第 ${deleted.deletedIndex} 话，剩余 ${deleted.chapterCount} 话已重新排序`);
      void refreshConfirmedChapters(`已从原书删除第 ${deleted.deletedIndex} 话，剩余 ${deleted.chapterCount} 话已重新排序`);
      return true;
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setChapterEditError(getChapterMutationErrorMessage('删除', error));
      return false;
    } finally {
      finishViewAction(action);
      if (chapterMutationControllerRef.current === action.controller) chapterMutationControllerRef.current = null;
      if (isCurrentViewAction(action)) setIsSavingChapterEdit(false);
    }
  };

  const handleFavoriteToggle = () => {
    if (isUpdatingFavorite) {
      return;
    }

    const action = beginViewAction();
    setFavoriteError('');
    setIsUpdatingFavorite(true);
    void setBookFavorite(book.id, !book.favorite, action.controller.signal)
      .then((nextBook) => {
        if (isCurrentViewAction(action)) adoptUpdatedBook(nextBook, 'favorite');
      })
      .catch((error: unknown) => {
        if (isCurrentViewAction(action)) setFavoriteError(error instanceof Error ? error.message : '收藏更新失败');
      })
      .finally(() => {
        finishViewAction(action);
        if (isCurrentViewAction(action)) setIsUpdatingFavorite(false);
      });
  };

  const handleReadingToggle = () => {
    if (isUpdatingReadingStatus) {
      return;
    }

    const action = beginViewAction();
    setReadingStatusError('');
    setShareMessage('');
    setIsUpdatingReadingStatus(true);
    const nextFinished = !isFinished;
    void setBookReadingCompletion(book.id, nextFinished, action.controller.signal)
      .then((nextBook) => {
        if (!isCurrentViewAction(action)) return;
        readingMutationRevisionRef.current += 1;
        catalogRequestsRef.current.get('progress')?.abort();
        catalogRequestsRef.current.delete('progress');
        if (catalogRetryFocusRef.current === 'progress') catalogRetryFocusRef.current = null;
        adoptUpdatedBook(nextBook, 'reading');
        setReadingProgress(applyBookReadingCompletion(displayedReadingProgress, nextBook, nextFinished));
        setProgressLoadState('ready');
        setShareMessage(nextFinished ? '已标记为读完' : '已重置为未读');
      })
      .catch((error: unknown) => {
        if (isCurrentViewAction(action)) setReadingStatusError(error instanceof Error ? error.message : '阅读状态更新失败');
      })
      .finally(() => {
        finishViewAction(action);
        if (isCurrentViewAction(action)) setIsUpdatingReadingStatus(false);
      });
  };

  const handleShare = async () => {
    const action = beginViewAction();
    const shareUrl = window.location.href;
    setShareMessage('');
    try {
      if (navigator.share) {
        await navigator.share({ title: book.title, url: shareUrl });
      } else {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(shareUrl);
        if (isCurrentViewAction(action)) setShareMessage('链接已复制');
      }
    } catch (error) {
      if (!isCurrentViewAction(action)) return;
      setShareMessage(error instanceof Error && error.name === 'AbortError' ? '分享已取消' : `可手动复制链接：${shareUrl}`);
    } finally {
      finishViewAction(action);
    }
  };

  const handleDeleteConfirm = () => {
    const action = beginViewAction();
    setIsDeleting(true);
    setDeleteError('');
    void deleteBook(book.id, action.controller.signal)
      .then(() => {
        if (isCurrentViewAction(action)) navigate(collectionReturn ? collectionReturn.pathname + collectionReturn.search : ROUTES.library, { state: collectionReturn ? { restoreNavigationKey: collectionReturn.key } : undefined });
      })
      .catch((error: unknown) => {
        if (isCurrentViewAction(action)) {
          setDeleteError(error instanceof Error ? error.message : '删除失败');
          setIsDeleting(false);
        }
      })
      .finally(() => {
        finishViewAction(action);
      });
  };

  const cancelSourceActionForEdit = (input: BookUpdateInput) => {
    if (!Object.keys(input).some((key) => key.startsWith('source') || key === 'publicationStatus' || key === 'autoTranslateUpdates')) return;
    sourceActionControllerRef.current?.abort();
    sourceActionControllerRef.current = null;
    setIsCheckingSource(false);
    setIsAcknowledgingSource(false);
    setIsTranslatingSource(false);
    setSourceUpdateError('');
  };

  const handleEditSave = async (input: BookUpdateInput) => {
    cancelSourceActionForEdit(input);
    const action = beginViewAction();
    setIsSavingEdit(true);
    setEditError('');
    try {
      const nextBook = await updateBook(book.id, input, action.controller.signal);
      if (!isCurrentViewAction(action)) return;
      adoptUpdatedBook(nextBook, input);
      setIsEditDialogOpen(false);
      setIsSourceDialogOpen(false);
      setShareMessage('图书资料已更新');
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setEditError(error instanceof Error ? error.message : '保存失败');
    } finally {
      finishViewAction(action);
      if (isCurrentViewAction(action)) setIsSavingEdit(false);
    }
  };

  const handleReprocess = () => {
    if (isReprocessing || book.status === 'uploading' || book.status === 'processing') {
      return;
    }

    const action = beginViewAction();
    setReprocessError('');
    setIsReprocessing(true);
    void reprocessUploadedBook(book.id, crypto.randomUUID(), action.controller.signal)
      .then(async (response) => {
        if (!isCurrentViewAction(action)) return;
        setShareMessage('正在重新解析原文件，完成后会更新目录');
        const task = response.status === 'ready' ? null : await waitForUploadTask(response.task_id, action.controller.signal, Infinity, 4000);
        if (!isCurrentViewAction(action)) return;
        if (task?.status === 'failed') throw new Error(task.message || '重新解析失败');
        invalidateBookListCache();
        resetReaderChapterCache();
        setShareMessage('重新解析完成');
        setDetailReloadKey((key) => key + 1);
      })
      .catch((error: unknown) => {
        if (isCurrentViewAction(action)) {
          setShareMessage('');
          setReprocessError(error instanceof Error ? error.message : '重新解析失败');
        }
      })
      .finally(() => {
        finishViewAction(action);
        if (isCurrentViewAction(action)) setIsReprocessing(false);
      });
  };

  const handleDislikedToggle = () => {
    if (isUpdatingDisliked) return;

    const action = beginViewAction();
    setDislikeError('');
    setIsUpdatingDisliked(true);
    void setBookDisliked(book.id, !book.disliked, action.controller.signal)
      .then((nextBook) => {
        if (!isCurrentViewAction(action)) return;
        adoptUpdatedBook(nextBook, 'disliked');
        setShareMessage(nextBook.disliked ? '已移入“不喜欢”，它不会再出现在普通书架分类中' : '已恢复到书架');
      })
      .catch((error: unknown) => {
        if (isCurrentViewAction(action)) setDislikeError(error instanceof Error ? error.message : '不喜欢状态更新失败');
      })
      .finally(() => {
        finishViewAction(action);
        if (isCurrentViewAction(action)) setIsUpdatingDisliked(false);
      });
  };

  const handleSourceSave = async (input: BookUpdateInput) => {
    cancelSourceActionForEdit(input);
    const action = beginViewAction();
    setIsSavingEdit(true);
    setEditError('');
    try {
      const nextBook = await updateBook(book.id, input, action.controller.signal);
      if (!isCurrentViewAction(action)) return;
      adoptUpdatedBook(nextBook, input);

      let message = input.sourceUrl ? '原作关联已更新' : '已移除原作关联';
      if (input.sourceUrl) {
        try {
          const synced = await syncBookSourceCatalog(book.id, action.controller.signal);
          if (!isCurrentViewAction(action)) return;
          resetReaderChapterCache();
          setReaderResource(await getReaderResource(book.id, action.controller.signal));
          if (!isCurrentViewAction(action)) return;
          message = synced.renamedCount > 0
            ? `已按原作目录校正 ${synced.renamedCount} 个章节名`
            : synced.matchedCount > 0
              ? `已关联 ${synced.matchedCount} 话原作目录`
              : '原作已关联，源站暂未提供可同步目录';
        } catch (error: unknown) {
          if (!isCurrentViewAction(action)) return;
          message = `原作已关联；${error instanceof Error ? error.message : '目录同步失败，可稍后重新读取'}`;
        }
      }
      setIsSourceDialogOpen(false);
      setShareMessage(message);
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setEditError(error instanceof Error ? error.message : '保存失败');
    } finally {
      finishViewAction(action);
      if (isCurrentViewAction(action)) setIsSavingEdit(false);
    }
  };

  const handleReplaceBookFile = async (file: File, keepProgress: boolean) => {
    if (isReplacing || book.status === 'uploading' || book.status === 'processing') return;

    const action = beginViewAction();
    setReplaceError('');
    setReplaceProgress(0);
    setIsReplacing(true);
    let replacementAccepted = false;
    let replacementFailed = false;
    try {
      const response = await replaceBookFile(book.id, file, {
        keepProgress,
        signal: action.controller.signal,
        onProcessing: () => setReplaceProgress(72),
        onProgress: setReplaceProgress,
      });
      if (!isCurrentViewAction(action)) return;
      replacementAccepted = true;
      savePendingReplacement(book.id, { keepProgress, taskId: response.task_id });
      replacementObservationRef.current?.abort();
      const observationController = new AbortController();
      replacementObservationRef.current = observationController;
      setIsReplaceDialogOpen(false);
      const nextBook = { ...book, status: 'processing' as const };
      adoptUpdatedBook(nextBook, 'processing');
      setReaderResource(null);
      resetReaderChapterCache();
      setShareMessage('新译本已上传，正在安全替换；累计阅读时长不会丢失');

      const task = response.status === 'ready' ? null : await waitForUploadTask(response.task_id, observationController.signal);
      if (!isCurrentViewAction(action)) return;
      if (task?.status === 'failed') {
        replacementFailed = true;
        clearPendingReplacement(book.id);
        throw new Error(task.message || '新文件解析失败，旧版本已自动恢复');
      }
      if (task?.status === 'ready' || response.status === 'ready') {
        clearPendingReplacement(book.id);
        setShareMessage(keepProgress ? '替换完成，阅读时长和百分比进度已保留' : '替换完成，阅读时长已保留，阅读位置已重置');
      } else {
        setShareMessage('服务器仍在处理替换任务，可稍后返回或前往上传页面查看进度。');
      }
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setReplaceError(replacementAccepted && !replacementFailed ? '' : error instanceof Error ? error.message : '替换书籍文件失败');
      if (replacementAccepted && isCurrentViewAction(action)) {
        setShareMessage(replacementFailed ? '替换失败，旧版本已保留' : '文件已上传，替换结果暂时无法确认；请稍后返回或前往上传页面查看进度。');
      }
    } finally {
      finishViewAction(action);
      if (isCurrentViewAction(action)) {
        setIsReplacing(false);
        setReplaceProgress(0);
      }
      if (replacementObservationRef.current) {
        replacementObservationRef.current.abort();
        replacementObservationRef.current = null;
      }
      if (replacementAccepted && isCurrentViewAction(action)) {
        setDetailReloadKey((currentKey) => currentKey + 1);
      }
    }
  };

  const handleCoverSave = async (file: File) => {
    const action = beginViewAction();
    setIsSavingCover(true);
    setCoverError('');
    try {
      const nextBook = await uploadBookCover(book.id, file, action.controller.signal);
      if (!isCurrentViewAction(action)) return;
      adoptUpdatedBook(nextBook, 'cover');
      setIsCoverDialogOpen(false);
      setShareMessage('封面已更新');
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setCoverError(error instanceof Error ? error.message : '封面上传失败');
    } finally {
      finishViewAction(action);
      if (isCurrentViewAction(action)) setIsSavingCover(false);
    }
  };

  const handleCoverRemove = async () => {
    const action = beginViewAction();
    setIsSavingCover(true);
    setCoverError('');
    try {
      const nextBook = await removeCustomBookCover(book.id, action.controller.signal);
      if (!isCurrentViewAction(action)) return;
      adoptUpdatedBook(nextBook, 'cover');
      setIsCoverDialogOpen(false);
      setShareMessage(nextBook.coverUrl ? '已恢复原封面' : '已移除自定义封面');
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setCoverError(error instanceof Error ? error.message : '恢复原封面失败');
    } finally {
      finishViewAction(action);
      if (isCurrentViewAction(action)) setIsSavingCover(false);
    }
  };

  const adoptUpdatedBook = (nextBook: Book, action: BookActionKind) => {
    detailMutationRevisionRef.current += 1;
    setResult((current) => current?.book && current.bookId === bookId
      ? { book: mergeBookActionResult(current.book, nextBook, action), bookId } : current);
    setAllBooks((currentBooks) => currentBooks.map((candidate) => mergeBookActionResult(candidate, nextBook, action)));
  };

  const handleSourceCheck = () => {
    if (sourceActionControllerRef.current || isSavingEdit) return;
    const controller = new AbortController();
    sourceActionControllerRef.current = controller;
    setIsCheckingSource(true);
    setSourceUpdateError('');
    void checkBookSourceUpdate(book.id, controller.signal)
      .then((nextBook) => {
        if (controller.signal.aborted) return;
        adoptUpdatedBook(nextBook, 'source');
        setShareMessage(nextBook.sourceUpdateCount ? `发现原作新增 ${nextBook.sourceUpdateCount} 话` : '原作暂无更新');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSourceUpdateError(error instanceof Error ? error.message : '原作更新检查失败');
      })
      .finally(() => {
        if (sourceActionControllerRef.current === controller) {
          sourceActionControllerRef.current = null;
          setIsCheckingSource(false);
        }
      });
  };

  const handleSourceAcknowledge = () => {
    if (sourceActionControllerRef.current || isSavingEdit) return;
    const controller = new AbortController();
    sourceActionControllerRef.current = controller;
    setIsAcknowledgingSource(true);
    setSourceUpdateError('');
    void acknowledgeBookSourceUpdate(book.id, controller.signal)
      .then((nextBook) => {
        if (controller.signal.aborted) return;
        adoptUpdatedBook(nextBook, 'source');
        setShareMessage('已将原作更新标记为处理完毕');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSourceUpdateError(error instanceof Error ? error.message : '更新状态处理失败');
      })
      .finally(() => {
        if (sourceActionControllerRef.current === controller) {
          sourceActionControllerRef.current = null;
          setIsAcknowledgingSource(false);
        }
      });
  };

  const handleSourceTranslation = () => {
    if (sourceActionControllerRef.current || isSavingEdit) return;
    const controller = new AbortController();
    sourceActionControllerRef.current = controller;
    setIsTranslatingSource(true);
    setSourceUpdateError('');
    void translateBookSourceUpdates(book.id, controller.signal)
      .then((task) => {
        if (controller.signal.aborted) return;
        translationJobsRevisionRef.current += 1;
        void refreshBookTranslationJob();
        setShareMessage(
          task.status === 'review'
            ? '这批更新译稿已经完成，请从通知中查看并审核'
            : `已开始后台精翻 ${task.total_chapters} 话，完成后会通知你审核`,
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSourceUpdateError(error instanceof Error ? error.message : '更新翻译启动失败');
      })
      .finally(() => {
        if (sourceActionControllerRef.current === controller) {
          sourceActionControllerRef.current = null;
          setIsTranslatingSource(false);
        }
      });
  };

  const handleTranslationJobAction = async (
    kind: BookTranslationAction,
    action: (signal: AbortSignal) => Promise<WholeBookTranslationJob>,
    failureMessage: string,
  ) => {
    if (translationActionControllerRef.current) return;
    const viewAction = beginViewAction();
    translationActionControllerRef.current = viewAction.controller;
    translationJobsRevisionRef.current += 1;
    setTranslationJobAction(kind);
    setTranslationActionError('');
    try {
      const nextJob = await action(viewAction.controller.signal);
      if (!isCurrentViewAction(viewAction)) return;
      translationJobsRevisionRef.current += 1;
      setBookTranslationJob(nextJob);
    } catch (error: unknown) {
      if (isCurrentViewAction(viewAction)) setTranslationActionError(error instanceof Error ? error.message : failureMessage);
    } finally {
      finishViewAction(viewAction);
      if (translationActionControllerRef.current === viewAction.controller) {
        translationActionControllerRef.current = null;
        if (isCurrentViewAction(viewAction)) {
          setTranslationJobAction(null);
          window.dispatchEvent(new Event(TRANSLATION_JOBS_CHANGED_EVENT));
        }
      }
    }
  };

  const openTranslationReview = (jobId: string) => {
    cancelPendingChapterLoad();
    const next = new URLSearchParams(searchParams);
    next.set('translationReview', jobId);
    setSearchParams(next, { state: location.state });
  };

  const handlePublicShareToggle = () => {
    if (book.publicStatus === 'private' || book.publicStatus === 'rejected') {
      cancelPendingChapterLoad();
      setPublicShareError('');
      setShareDraft({
        publicDownloadAllowed: book.publicDownloadAllowed ?? false,
        shareNote: book.publicShareNote ?? '',
        sourceNote: book.publicSourceNote ?? '',
      });
      setIsShareDialogOpen(true);
      return;
    }

    const action = beginViewAction();
    setIsUpdatingPublicShare(true);
    setPublicShareError('');

    void cancelBookPublicShare(book.id, action.controller.signal)
      .then((nextBook) => {
        if (!isCurrentViewAction(action)) return;
        adoptUpdatedBook(nextBook, 'public');
        setShareMessage(getPublicShareMessage(nextBook.publicStatus));
      })
      .catch((error: unknown) => {
        if (isCurrentViewAction(action)) setPublicShareError(error instanceof Error ? error.message : '公共书库状态更新失败');
      })
      .finally(() => {
        finishViewAction(action);
        if (isCurrentViewAction(action)) setIsUpdatingPublicShare(false);
      });
  };

  const handlePublicShareSubmit = async (input: BookPublicShareInput) => {
    const action = beginViewAction();
    setIsUpdatingPublicShare(true);
    setPublicShareError('');

    try {
      const nextBook = await requestBookPublicShare(book.id, input, action.controller.signal);
      if (!isCurrentViewAction(action)) return;
      adoptUpdatedBook(nextBook, 'public');
      setShareMessage(getPublicShareMessage(nextBook.publicStatus));
      setIsShareDialogOpen(false);
    } catch (error: unknown) {
      if (isCurrentViewAction(action)) setPublicShareError(error instanceof Error ? error.message : '公共书库申请提交失败');
    } finally {
      finishViewAction(action);
      if (isCurrentViewAction(action)) setIsUpdatingPublicShare(false);
    }
  };

  return (
    <div className="book-detail-page space-y-6 sm:space-y-8 lg:space-y-4" data-navigation-loading={!isDetailContentReady}>
      <section className="relative z-20 isolate border-y border-ink/[0.08] dark:border-white/[0.07]">
        <div className="absolute inset-0 overflow-hidden">
          <CoverAmbientBackdrop coverUrl={book.coverUrl} />
        </div>

        <div className="book-detail-summary relative z-10 mx-auto max-w-[1320px] px-5 py-5 sm:px-7 sm:py-6 lg:px-6 lg:py-4">
          <Link className="book-detail-back mb-2 inline-flex min-h-10 items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-night-ink" state={collectionReturn ? { restoreNavigationKey: collectionReturn.key } : undefined} to={collectionReturn ? collectionReturn.pathname + collectionReturn.search : isOwnedBook ? ROUTES.library : ROUTES.publicLibrary}>
            <ChevronLeft className="h-4 w-4" />
            {getCollectionReturnLabel(collectionReturn?.pathname ?? (isOwnedBook ? ROUTES.library : ROUTES.publicLibrary))}
          </Link>
          <div className="book-detail-heading grid gap-6 md:grid-cols-[210px_minmax(0,1fr)] md:gap-8 lg:grid-cols-[160px_minmax(0,1fr)] lg:gap-6">
            <div className="book-detail-cover relative mr-auto md:mx-0">
              <BookCover book={book} size="xl" />
              {isOwnedBook && (
                <button
                  aria-label="修改封面"
                  className="absolute bottom-3 right-3 z-20 grid h-10 w-10 place-items-center rounded-full bg-stone-950/75 text-white shadow-lg backdrop-blur-md transition hover:bg-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                  onClick={() => {
                    setCoverError('');
                    cancelPendingChapterLoad();
                    setIsCoverDialogOpen(true);
                  }}
                  title="修改封面"
                  type="button"
                >
                  <Camera className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="book-detail-info min-w-0">
              <BookTags maxVisible={6} tags={book.language === 'ja' && !book.tags.includes('日文原版') ? ['日文原版', ...book.tags] : book.tags} />
              <h1
                className={cn(
                  'app-page-title mt-3 max-w-[820px] break-words font-display font-semibold tracking-normal text-stone-950 [overflow-wrap:anywhere] [text-wrap:pretty] dark:text-night-ink',
                  getBookTitleLayoutClass(book.title),
                )}
              >
                {book.title}
              </h1>
              {book.subtitle &&
                book.subtitle.toLowerCase() !== book.readerType.toLowerCase() &&
                (!book.fileExt || book.subtitle.toLowerCase() !== book.fileExt.toLowerCase().replace(/^\./, '')) &&
                !book.tags.some(tag => tag.toLowerCase() === book.subtitle?.toLowerCase()) && (
                  <p className="book-detail-subtitle mt-2 text-stone-500 dark:text-night-soft">{book.subtitle}</p>
                )}
              <p className="book-detail-author mt-2 text-sm text-stone-600 dark:text-night-soft">{book.author?.trim() || '佚名'} 著</p>

              {readerAvailability.canReadInBrowser && (
                <LinkButton className="mt-4 min-h-11 w-full sm:hidden" icon={<Play className="h-4 w-4 fill-current" />} state={navigationState} to={getReaderRouteForBook(book)}>
                  {currentProgressPercent > 0 || hasBookReadingHistory(book) ? '继续阅读' : '开始阅读'}
                </LinkButton>
              )}

              <BookColophon book={book} />

              <div aria-busy={progressLoadState === 'loading'} aria-label="阅读进度" className="book-detail-reading-progress focus:!outline-none" ref={progressRootRef} role="region" tabIndex={-1}>
                <ProgressBar className="book-detail-progress mt-4 max-w-[820px]" value={currentProgressPercent} />
                {!chapterRefresh && progressLoadState !== 'ready' && (
                  <div className="book-detail-progress-status mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500 dark:text-night-soft" role="status">
                    <span>{progressLoadState === 'loading' ? '正在读取阅读位置…' : '阅读位置暂时读取失败，已保留已知进度。'}</span>
                    <Button disabled={progressLoadState === 'loading'} onClick={() => { catalogRetryFocusRef.current = 'progress'; void loadCatalogSection('progress'); }} variant="ghost">{progressLoadState === 'loading' ? '读取中…' : '重试阅读位置'}</Button>
                  </div>
                )}
              </div>
              <div className="book-detail-actions mt-4 grid max-w-[820px] grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-center">
                {readerAvailability.canReadInBrowser ? (
                  <LinkButton className="col-span-2 hidden min-h-10 w-full px-3.5 sm:inline-flex sm:w-auto" icon={<Play className="h-4 w-4 fill-current" />} state={navigationState} to={getReaderRouteForBook(book)}>
                    {currentProgressPercent > 0 || hasBookReadingHistory(book) ? '继续阅读' : '开始阅读'}
                  </LinkButton>
                ) : (
                  <Button className="col-span-2 min-h-10 w-full px-3.5 sm:w-auto" disabled icon={<Play className="h-4 w-4 fill-current" />}>
                    暂无在线阅读
                  </Button>
                )}

                {isOwnedBook && (
                  <>
                    <Button className="col-span-1 min-h-10 w-full px-3.5 sm:w-auto" disabled={isUpdatingFavorite} icon={<Heart className={book.favorite ? 'h-4 w-4 fill-current text-accent' : 'h-4 w-4'} />} onClick={handleFavoriteToggle} variant="secondary">
                      {isUpdatingFavorite ? '更新中...' : book.favorite ? '取消收藏' : '加入收藏'}
                    </Button>
                    <Button className="col-span-1 min-h-10 w-full px-3.5 sm:w-auto" disabled={isUpdatingDisliked} icon={<ThumbsDown className={book.disliked ? 'h-4 w-4 fill-current text-accent' : 'h-4 w-4'} />} onClick={handleDislikedToggle} variant="secondary">
                      {isUpdatingDisliked ? '更新中...' : book.disliked ? '恢复显示' : '不喜欢'}
                    </Button>
                    <Button
                      className="col-span-1 min-h-10 w-full px-3.5 sm:w-auto"
                      disabled={isUpdatingReadingStatus}
                      icon={isFinished ? <RotateCcw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                      onClick={handleReadingToggle}
                      variant="secondary"
                    >
                      {isUpdatingReadingStatus ? '更新中...' : isFinished ? '标记未读' : '标记已读'}
                    </Button>
                    {canAppendChapter && (
                      <Button
                        className="col-span-1 min-h-10 w-full px-3.5 sm:w-auto"
                        disabled={Boolean(chapterRefresh)}
                        icon={<Plus className="h-4 w-4" />}
                        onClick={() => {
                          setAppendError('');
                          cancelPendingChapterLoad();
                          setIsAppendDialogOpen(true);
                        }}
                        variant="secondary"
                      >
                        追加章节
                      </Button>
                    )}
                  </>
                )}
                <BookActionMenu
                  book={book}
                  canDownloadOriginal={canDownloadOriginal}
                  isDeleting={isDeleting}
                  isDownloading={isDownloading}
                  isOwnedBook={isOwnedBook}
                  isReprocessing={isReprocessing}
                  isReplacing={isReplacing}
                  isUpdatingPublicShare={isUpdatingPublicShare}
                  onDelete={() => {
                    setDeleteError('');
                    cancelPendingChapterLoad();
                    setIsDeleteDialogOpen(true);
                  }}
                  onDownload={() => {
                    if (isDownloading) return;
                    setDownloadError('');
                    setIsDownloading(true);
                    const action = beginViewAction();
                    void downloadOriginalBookFile(book, action.controller.signal)
                      .catch((error: unknown) => {
                        if (isCurrentViewAction(action)) setDownloadError(error instanceof Error ? error.message : '下载失败');
                      })
                      .finally(() => {
                        finishViewAction(action);
                        if (isCurrentViewAction(action)) setIsDownloading(false);
                      });
                  }}
                  onEdit={() => {
                    setEditError('');
                    cancelPendingChapterLoad();
                    setIsEditDialogOpen(true);
                  }}
                  onEditCover={() => {
                    setCoverError('');
                    cancelPendingChapterLoad();
                    setIsCoverDialogOpen(true);
                  }}
                  onEditSource={() => {
                    setEditError('');
                    cancelPendingChapterLoad();
                    setIsSourceDialogOpen(true);
                  }}
                  onPublicShare={handlePublicShareToggle}
                  onReplace={() => {
                    setReplaceError('');
                    cancelPendingChapterLoad();
                    setIsReplaceDialogOpen(true);
                  }}
                  onReprocess={handleReprocess}
                  onShare={handleShare}
                />
              </div>
              <div className="book-detail-status-grid mt-3 grid gap-3">
                {(isOwnedBook || Boolean(book.sourceUrl)) && (
                  <SourceUpdateStatusStrip
                    book={book}
                    errorMessage={sourceUpdateError}
                    isOwnedBook={isOwnedBook}
                    isAcknowledging={isAcknowledgingSource}
                    isChecking={isCheckingSource}
                    hasTranslationJob={bookTranslationJob !== null && bookTranslationJob.status !== 'ready'}
                    isTranslating={isTranslatingSource}
                    onAcknowledge={handleSourceAcknowledge}
                    onCheck={handleSourceCheck}
                    onEditSource={() => {
                      setEditError('');
                      cancelPendingChapterLoad();
                      setIsSourceDialogOpen(true);
                    }}
                    onTranslate={handleSourceTranslation}
                  />
                )}
                <ReadingResourceStatusStrip status={readingStatus} />
                <PublicShareStatusCard book={book} isOwnedBook={isOwnedBook} />
              </div>
              {isOwnedBook && bookTranslationJob && (
                <BookTranslationStatusStrip
                  errorMessage={translationActionError}
                  processingAction={translationJobAction}
                  isReviewLoading={translationReviewJobId === bookTranslationJob.id && !translationReview && !translationReviewError}
                  job={bookTranslationJob}
                  onConcurrencyChange={(value) => void handleTranslationJobAction(
                    'concurrency',
                    (signal) => updateWholeBookTranslationConcurrency(bookTranslationJob.id, value, signal),
                    '并发调整失败',
                  )}
                  onPause={() => void handleTranslationJobAction(
                    'pause',
                    (signal) => pauseWholeBookTranslation(bookTranslationJob.id, signal),
                    '暂停翻译失败',
                  )}
                  onResume={() => void handleTranslationJobAction(
                    'resume',
                    (signal) => resumeWholeBookTranslation(bookTranslationJob.id, signal),
                    '继续翻译失败',
                  )}
                  onRetry={() => void handleTranslationJobAction(
                    'retry',
                    (signal) => retryWholeBookTranslation(bookTranslationJob.id, signal),
                    '重试翻译失败',
                  )}
                  onReview={() => openTranslationReview(bookTranslationJob.id)}
                />
              )}
              {!readerAvailability.canReadInBrowser && <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{readerAvailability.reason ?? '当前格式还没有可用的在线阅读页，可先下载原文件阅读。'}</p>}
              {!isOwnedBook && book.publicDownloadAllowed === false && <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">分享者关闭了原文件下载，这本书仍然可以在线阅读。</p>}
              {isDownloading && <p role="status" className="mt-3 text-sm text-stone-500 dark:text-night-soft">正在准备下载…</p>}
              {downloadError && <p className="mt-3 text-sm text-red-500">{downloadError}</p>}
              {favoriteError && <p className="mt-3 text-sm text-red-500">{favoriteError}</p>}
              {dislikeError && <p className="mt-3 text-sm text-red-500">{dislikeError}</p>}
              {readingStatusError && <p className="mt-3 text-sm text-red-500">{readingStatusError}</p>}
              {publicShareError && <p className="mt-3 text-sm text-red-500">{publicShareError}</p>}
              {reprocessError && <p className="mt-3 text-sm text-red-500">{reprocessError}</p>}
              {replaceError && !isReplaceDialogOpen && <p className="mt-3 text-sm text-red-500">{replaceError}</p>}
              {editError && !isEditDialogOpen && !isSourceDialogOpen && <p className="mt-3 text-sm text-red-500">{editError}</p>}
              {deleteError && <p className="mt-3 text-sm text-red-500">{deleteError}</p>}
              {shareMessage && !chapterRefresh && <p role="status" className="mt-3 break-all select-text text-sm text-accent dark:text-peach">{shareMessage}</p>}
              {appendSuccess && !chapterRefresh && (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-accent dark:text-peach">
                  <span>已追加“{appendSuccess.title}”</span>
                  <Link className="font-medium underline decoration-current/35 underline-offset-4 hover:decoration-current" state={navigationState} to={`${getReaderRouteForBook(book)}?chapter=${appendSuccess.index}`}>阅读新增章节</Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
      <div className={cn("mx-auto grid w-full max-w-[1260px] gap-5 items-start", seriesShelf ? "lg:grid-cols-[1fr_360px]" : "grid-cols-1")}>
        <div className="space-y-5 lg:col-span-1">
          <Panel className="book-detail-description">
            <SectionHeader title="简介" />
            <BookDescription description={book.description} />
            {isPublicBook && (
              <PublicCommentsPanel
                bookId={book.id}
                isVisible={areCommentsVisible}
                onVisibilityChange={handleCommentsVisibilityChange}
                targetLabel="整本书评论"
                targetType="book"
              />
            )}
          </Panel>

          <Panel>
            <div aria-busy={chapterRefresh ? chapterRefresh.status === 'loading' : catalogLoadState === 'loading' || (canAppendChapter && chapterToolsLoadState === 'loading')} aria-label="目录" className="book-detail-catalog focus:!outline-none" ref={catalogRootRef} role="region" tabIndex={-1}>
            <SectionHeader title="目录" />
            {chapterRefresh && (
              <div className="book-detail-chapter-refresh mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600 focus:!outline-none dark:text-night-copy" role="status" tabIndex={-1}>
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{chapterRefresh.message}。{chapterRefresh.status === 'loading' ? '正在更新目录…' : '目录暂时刷新失败，可重试刷新。'}</span>
                <Button disabled={chapterRefresh.status === 'loading'} onClick={() => void refreshConfirmedChapters(chapterRefresh.message)} variant="ghost">{chapterRefresh.status === 'loading' ? '正在刷新…' : '重试刷新'}</Button>
              </div>
            )}
            {!chapterRefresh && catalogLoadState === 'loading' && <p className="book-detail-catalog-loading mt-4 text-sm text-stone-500 dark:text-night-soft" role="status">正在加载目录…</p>}
            {!chapterRefresh && catalogLoadState === 'failed' && (
              <div className="book-detail-catalog-error mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600 dark:text-night-copy" role="alert">
                <span>目录暂时加载失败，请重试。</span>
                <Button onClick={() => { cancelPendingChapterLoad(); catalogRetryFocusRef.current = 'resource'; void loadCatalogSection('resource'); }} variant="ghost">重试目录</Button>
              </div>
            )}
            {!chapterRefresh && isOwnedBook && canAppendChapter && readerResource && chapterToolsLoadState !== 'ready' && (
              <div className="book-detail-chapter-tools-status mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600 dark:text-night-copy" role="status">
                <span>{chapterToolsLoadState === 'loading' ? '正在加载章节编辑入口…' : '章节编辑入口暂时加载失败。'}</span>
                <Button disabled={chapterToolsLoadState === 'loading'} onClick={() => { cancelPendingChapterLoad(); catalogRetryFocusRef.current = 'chapters'; void loadCatalogSection('chapters'); }} variant="ghost">{chapterToolsLoadState === 'loading' ? '加载中…' : '重试编辑入口'}</Button>
              </div>
            )}
            {!chapterRefresh && hasPublicationRefreshError && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400" role="status">
                <span>目录更新暂时失败，已保留当前内容；将自动重试。</span>
                <button className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 font-medium text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:text-peach" onClick={() => window.dispatchEvent(new Event(TRANSLATED_BOOKS_CHANGED_EVENT))} type="button">重试</button>
              </div>
            )}
            {!chapterRefresh && readerResource && <div className="book-detail-catalog-content"><BookDetailCatalog
              activeChapterIndex={activeChapterIndex}
              activePageIndex={activePageIndex}
              book={book}
              commentsVisible={areCommentsVisible}
              editableChapterIndexes={editableChapterIndexes}
              editingChapterIndex={editingChapterIndex}
              isPublicBook={isPublicBook}
              onCommentsVisibilityChange={handleCommentsVisibilityChange}
              onEditChapter={isOwnedBook ? handleEditChapterRequest : undefined}
              progressPercent={catalogProgressPercent}
              readerResource={readerResource}
            /></div>}
            </div>
          </Panel>

          {seriesShelf && (
            <div className="lg:hidden">
              <Panel>
                <BookSeriesPanel shelf={seriesShelf} />
              </Panel>
            </div>
          )}
        </div>

        {seriesShelf && (
          <div className="hidden lg:block lg:sticky lg:top-24">
            <Panel>
              <BookSeriesPanel shelf={seriesShelf} />
            </Panel>
          </div>
        )}
      </div>
      <BookEditDialog
        book={book}
        errorMessage={editError}
        isOpen={isEditDialogOpen}
        isSaving={isSavingEdit}
        onCancel={() => setIsEditDialogOpen(false)}
        onSave={handleEditSave}
        onDraftChange={() => setEditError('')}
      />
      <BookCoverDialog
        book={book}
        errorMessage={coverError}
        isOpen={isCoverDialogOpen}
        isSaving={isSavingCover}
        onCancel={() => setIsCoverDialogOpen(false)}
        onRemove={handleCoverRemove}
        onSave={handleCoverSave}
        onSelectionChange={() => setCoverError('')}
      />
      <SourceLinkDialog
        book={book}
        errorMessage={editError}
        isOpen={isSourceDialogOpen}
        isSaving={isSavingEdit}
        onCancel={() => setIsSourceDialogOpen(false)}
        onSave={handleSourceSave}
        onDraftChange={() => setEditError('')}
      />
      <AppendChapterDialog
        key={`append-${bookId}`}
        bookId={bookId}
        bookTitle={book.title}
        errorMessage={appendError}
        existingChapterCount={appendChapterCount}
        isOpen={isAppendDialogOpen}
        isSaving={isAppendingChapter}
        onCancel={() => setIsAppendDialogOpen(false)}
        onDiscardDraft={() => setAppendError('')}
        onSave={handleAppendChapter}
      />
      <EditChapterDialog
        key={bookId}
        bookId={bookId}
        chapter={chapterBeingEdited}
        errorMessage={chapterEditError}
        hasImages={chapterBeingEdited?.hasImages}
        isSaving={isSavingChapterEdit}
        onCancel={() => setChapterBeingEdited(null)}
        onDiscardDraft={() => setChapterEditError('')}
        onDelete={handleChapterDelete}
        onSave={handleChapterEditSave}
      />
      <TranslationDraftReviewDialog
        errorMessage={translationReviewError}
        processingAction={translationReviewAction}
        onAccept={() => void handleAcceptTranslationReview()}
        onCancel={closeTranslationReview}
        onReject={() => void handleRejectTranslationReview()}
        review={translationReview}
      />
      <PublicShareRequestDialog
        draft={shareDraft}
        errorMessage={publicShareError}
        isOpen={isShareDialogOpen}
        isSaving={isUpdatingPublicShare}
        onCancel={() => setIsShareDialogOpen(false)}
        onChange={setShareDraft}
        onSubmit={handlePublicShareSubmit}
      />
      <DeleteBookDialog
        bookTitle={book.title}
        errorMessage={deleteError}
        isDeleting={isDeleting}
        isOpen={isDeleteDialogOpen}
        onCancel={() => setIsDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
      <ReplaceBookFileDialog
        errorMessage={replaceError}
        isOpen={isReplaceDialogOpen}
        isReplacing={isReplacing}
        onCancel={() => setIsReplaceDialogOpen(false)}
        onReplace={handleReplaceBookFile}
        progress={replaceProgress}
      />
      </div>
  );
}

interface BookActionMenuProps {
  book: Book;
  canDownloadOriginal: boolean;
  isDeleting: boolean;
  isDownloading: boolean;
  isOwnedBook: boolean;
  isReprocessing: boolean;
  isReplacing: boolean;
  isUpdatingPublicShare: boolean;
  onDelete: () => void;
  onDownload: () => void;
  onEdit: () => void;
  onEditCover: () => void;
  onEditSource: () => void;
  onPublicShare: () => void;
  onReplace: () => void;
  onReprocess: () => void;
  onShare: () => void;
}

function BookActionMenu({ book, canDownloadOriginal, isDeleting, isDownloading, isOwnedBook, isReprocessing, isReplacing, isUpdatingPublicShare, onDelete, onDownload, onEdit, onEditCover, onEditSource, onPublicShare, onReplace, onReprocess, onShare }: BookActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const layout = useBookMenuPosition(isOpen, triggerRef, menuRef, () => setIsOpen(false), { width: 224, maxHeight: 352 });

  useLayoutEffect(() => {
    if (!isOpen || !layout) return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    focusBookMenuItem(buttons.find((button) => button === document.activeElement) ?? buttons[0]);
  }, [isOpen, layout]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Tab') {
        triggerRef.current?.focus({ preventScroll: true });
        setIsOpen(false);
        return;
      }
      if (!menuRef.current?.contains(document.activeElement)) return;
      const buttons = items();
      if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      focusBookMenuItem(buttons[next]);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleSelect = (action: () => void) => {
    // The menu item unmounts before a dialog records its return target.
    triggerRef.current?.focus({ preventScroll: true });
    setIsOpen(false);
    action();
  };

  return (
    <div className="relative col-span-1 w-11 sm:w-auto">
      {isOpen && createPortal(
        <button
          aria-label="关闭更多操作"
          className="fixed inset-0 z-[90] cursor-default bg-transparent"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setIsOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
          }}
          onPointerDown={(event) => event.stopPropagation()}
          tabIndex={-1}
          type="button"
        />,
        document.body,
      )}
      <button
        aria-controls="book-action-menu"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="更多操作"
        id="book-actions-trigger"
        className={cn('relative grid h-10 w-10 place-items-center rounded-xl bg-stone-100 text-stone-600 transition hover:bg-stone-200 hover:text-stone-900 dark:bg-white/[0.06] dark:text-night-soft dark:hover:bg-white/10 dark:hover:text-night-ink', isOpen && 'z-[51]')}
        ref={triggerRef}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen((current) => !current);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title="更多操作"
        type="button"
      >
        <Ellipsis className="h-5 w-5" />
      </button>
      {isOpen && createPortal(
        <div
          className="fixed z-[91] w-56 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-xl border border-stone-200 bg-white py-1.5 shadow-xl dark:border-white/10 dark:bg-[#211d25]"
          id="book-action-menu"
          aria-labelledby="book-actions-trigger"
          ref={menuRef}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={layout ?? { visibility: 'hidden' }}
        >
          {isOwnedBook && <BookActionMenuItem icon={<Pencil className="h-4 w-4" />} label="编辑资料" onClick={() => handleSelect(onEdit)} />}
          {isOwnedBook && <BookActionMenuItem icon={<ImagePlus className="h-4 w-4" />} label="更换封面" onClick={() => handleSelect(onEditCover)} />}
          {isOwnedBook && <BookActionMenuItem icon={<Link2 className="h-4 w-4" />} label={book.sourceUrl ? '原作资料' : '关联原作'} onClick={() => handleSelect(onEditSource)} />}
          {canDownloadOriginal && <BookActionMenuItem disabled={isDownloading} icon={<Download className="h-4 w-4" />} label={isDownloading ? '下载中...' : '下载原文件'} onClick={() => handleSelect(onDownload)} />}
          {isOwnedBook && <BookActionMenuItem disabled={isUpdatingPublicShare || book.status !== 'ready'} icon={<Globe2 className="h-4 w-4" />} label={getPublicShareActionLabel(book.publicStatus, isUpdatingPublicShare)} onClick={() => handleSelect(onPublicShare)} />}
          {isOwnedBook && <BookActionMenuItem disabled={!book.fileSize || isReplacing || isReprocessing || book.status === 'uploading' || book.status === 'processing'} icon={<FileUp className="h-4 w-4" />} label={isReplacing ? '正在替换...' : '替换书籍文件'} onClick={() => handleSelect(onReplace)} />}
          {isOwnedBook && <BookActionMenuItem disabled={!book.fileSize || isReprocessing || book.status === 'uploading' || book.status === 'processing'} icon={<RotateCcw className="h-4 w-4" />} label={isReprocessing ? '文件解析中...' : '重新解析文件'} onClick={() => handleSelect(onReprocess)} />}
          <BookActionMenuItem icon={<Share2 className="h-4 w-4" />} label="分享" onClick={() => handleSelect(onShare)} />
          {isOwnedBook && (
            <div className="mt-1 border-t border-stone-200 pt-1 dark:border-white/10">
              <BookActionMenuItem danger disabled={isDeleting} icon={<Trash2 className="h-4 w-4" />} label={isDeleting ? '删除中...' : '删除图书'} onClick={() => handleSelect(onDelete)} />
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function BookActionMenuItem({ danger = false, disabled = false, icon, label, onClick }: { danger?: boolean; disabled?: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  };

  return (
    <button
      className={cn('flex min-h-10 w-full items-center gap-3 px-3.5 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-45', danger ? 'text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30' : 'text-stone-700 hover:bg-stone-100 dark:text-night-copy dark:hover:bg-white/[0.07]')}
      disabled={disabled}
      onClick={handleClick}
      onPointerDown={(event) => event.stopPropagation()}
      role="menuitem"
      type="button"
    >
      <span className="shrink-0 opacity-75">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

interface PublicShareRequestDialogProps {
  draft: BookPublicShareInput;
  errorMessage?: string;
  isOpen: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onChange: (input: BookPublicShareInput) => void;
  onSubmit: (input: BookPublicShareInput) => void;
}

function PublicShareRequestDialog({ draft, errorMessage, isOpen, isSaving, onCancel, onChange, onSubmit }: PublicShareRequestDialogProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, onCancel, !isSaving);
  if (!isOpen) {
    return null;
  }

  const shareNote = draft.shareNote ?? '';
  const sourceNote = draft.sourceNote ?? '';

  return (
    <ViewportDialogPortal className="z-[100] grid items-start justify-items-center bg-stone-950/35 backdrop-blur-sm sm:items-center">
      <div aria-busy={isSaving} aria-labelledby="public-share-title" aria-modal="true" className="book-management-dialog book-action-dialog book-share-dialog flex max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-stone-200 bg-white shadow-2xl dark:border-white/10 dark:bg-night" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="book-share-heading flex shrink-0 items-start justify-between gap-4 border-b border-stone-200 px-5 py-4 dark:border-white/10">
          <div>
            <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="public-share-title">提交到公共书库</h2>
            <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">补充一点给管理员和读者看的说明，审核会更清楚。</p>
          </div>
          <button
            aria-label="关闭公共书库提交"
            className="book-dialog-close grid h-9 w-9 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-white/10 dark:hover:text-night-ink"
            disabled={isSaving}
            onClick={onCancel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="book-share-content min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 reader-scrollbar">
          <label className="block">
            <span className="text-sm font-medium text-stone-900 dark:text-night-ink">分享说明</span>
            <textarea
              className="mt-2 min-h-28 w-full resize-y rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm leading-6 text-stone-900 outline-none transition focus:border-accent dark:border-white/10 dark:bg-white/[0.04] dark:text-night-ink"
              disabled={isSaving}
              maxLength={600}
              onChange={(event) => onChange({ ...draft, shareNote: event.target.value })}
              placeholder="比如推荐理由、适合谁读、版本特点。"
              value={shareNote}
            />
            <span className="mt-1 block text-right text-xs text-stone-400">{shareNote.length}/600</span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-stone-900 dark:text-night-ink">来源说明</span>
            <textarea
              className="mt-2 min-h-20 w-full resize-y rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm leading-6 text-stone-900 outline-none transition focus:border-accent dark:border-white/10 dark:bg-white/[0.04] dark:text-night-ink"
              disabled={isSaving}
              maxLength={300}
              onChange={(event) => onChange({ ...draft, sourceNote: event.target.value })}
              placeholder="比如自扫、自购整理、网络公开资源；不确定就简单写明。"
              value={sourceNote}
            />
            <span className="mt-1 block text-right text-xs text-stone-400">{sourceNote.length}/300</span>
          </label>

          <label className="flex items-start gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm dark:border-white/10 dark:bg-white/[0.04]">
            <input
              checked={draft.publicDownloadAllowed}
              className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300 text-accent focus:ring-accent"
              disabled={isSaving}
              onChange={(event) => onChange({ ...draft, publicDownloadAllowed: event.target.checked })}
              type="checkbox"
            />
            <span>
              <span className="block font-medium text-stone-900 dark:text-night-ink">允许其他用户下载原文件</span>
              <span className="mt-1 block leading-6 text-stone-500 dark:text-stone-400">关闭后仍可在线阅读，但公共书库里的其他用户不能直接下载原始文件。</span>
            </span>
          </label>

          {errorMessage && <p role="alert" className="whitespace-pre-wrap rounded-2xl border border-red-200 [overflow-wrap:anywhere] bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">{errorMessage}</p>}
        </div>

        <div className="book-action-footer book-share-footer flex shrink-0 flex-col-reverse gap-3 border-t border-stone-200 px-5 py-4 dark:border-white/10 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button disabled={isSaving} onClick={onCancel} variant="secondary">
            取消
          </Button>
          <Button disabled={isSaving} icon={<Globe2 className="h-4 w-4" />} onClick={() => onSubmit(draft)}>
            {isSaving ? '提交中...' : '提交审核'}
          </Button>
        </div>
      </div>
    </ViewportDialogPortal>
  );
}


const readingStatusToneClass: Record<BookReadingStatusTone, string> = {
  accent: 'border-accent/45 text-accent dark:text-accent-soft',
  danger: 'border-red-400/70 text-red-600 dark:text-red-300',
  success: 'border-emerald-400/70 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-400/70 text-amber-700 dark:text-amber-300',
};

function ReadingResourceStatusStrip({ status }: { status: BookReadingStatus }) {
  const Icon = status.tone === 'success' ? CheckCircle2 : status.tone === 'danger' ? AlertCircle : Clock3;

  return (
    <div className={cn('min-w-0 border-l-2 pl-4', readingStatusToneClass[status.tone])}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Icon className="h-4 w-4" />
          {status.label}
        </p>
        <span className="text-xs opacity-80">{status.resourceLabel}</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{status.description}</p>
    </div>
  );
}

interface SourceUpdateStatusStripProps {
  book: Book;
  errorMessage: string;
  hasTranslationJob: boolean;
  isAcknowledging: boolean;
  isChecking: boolean;
  isTranslating: boolean;
  isOwnedBook: boolean;
  onAcknowledge: () => void;
  onCheck: () => void;
  onEditSource: () => void;
  onTranslate: () => void;
}

function SourceUpdateStatusStrip({ book, errorMessage, hasTranslationJob, isAcknowledging, isChecking, isOwnedBook, isTranslating, onAcknowledge, onCheck, onEditSource, onTranslate }: SourceUpdateStatusStripProps) {
  if (!book.sourceUrl) {
    return (
      <div className="mt-4 flex max-w-[820px] flex-col gap-3 border-l-2 border-accent/55 pl-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-stone-800 dark:text-night-copy"><Link2 className="h-4 w-4 text-accent" />尚未关联原作</p>
          <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">关联后会读取源站更新时间，并每 6 小时检查一次连载状态。</p>
        </div>
        <Button className="shrink-0 sm:min-h-9 sm:px-3 sm:text-xs" icon={<Link2 className="h-4 w-4" />} onClick={onEditSource} variant="secondary">关联原作</Button>
      </div>
    );
  }

  const isBusy = isChecking || isAcknowledging || isTranslating;
  const updateCount = book.sourceUpdateCount ?? 0;
  const hasUpdate = updateCount > 0;
  const isAutoCheckEnabled = book.publicationStatus === 'ongoing';
  const automaticCheckLabel = getAutomaticSourceCheckLabel(book);
  const details = [
    book.sourceEpisodeCount !== undefined ? `原作共 ${book.sourceEpisodeCount.toLocaleString()} 话` : null,
    book.sourceCharacterCount ? `${book.sourceCharacterCount.toLocaleString()} 字` : null,
    isAutoCheckEnabled ? (book.sourceCheckedAt ? `${formatDate(book.sourceCheckedAt)}检查` : '等待首次自动检查') : '已停止定时检查',
    book.sourceScheduleLabel ? `源站标注 ${book.sourceScheduleLabel}` : null,
  ].filter(Boolean).join(' · ');
  const statusError = errorMessage || book.sourceCheckError;
  const StatusIcon = book.publicationStatus === 'completed' && !hasUpdate && !isChecking ? CheckCircle2 : RotateCcw;

  return (
    <div className={cn('mt-4 max-w-[820px] border-l-2 pl-4', hasUpdate ? 'border-accent text-accent dark:text-peach' : statusError ? 'border-amber-400/70 text-amber-700 dark:text-amber-300' : 'border-stone-300 text-stone-600 dark:border-white/20 dark:text-night-soft')} id="book-source-update-status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium">
          <StatusIcon className={cn('h-4 w-4', isChecking && 'animate-spin')} />
          {hasUpdate ? `原作新增 ${updateCount} 话` : book.publicationStatus === 'completed' ? '原作已完结' : '原作更新监测中'}
        </p>
        {isOwnedBook && <span className="text-xs opacity-80">{isAutoCheckEnabled ? automaticCheckLabel : '不参与定时检查'}</span>}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <a className="inline-flex items-center gap-1 font-medium underline decoration-current/25 underline-offset-4 hover:decoration-current" href={book.sourceUrl} rel="noreferrer" target="_blank">
            打开原作 <ExternalLink className="h-3.5 w-3.5" />
          </a>
          {isOwnedBook && <button className="font-medium underline decoration-current/25 underline-offset-4 hover:decoration-current disabled:opacity-50" disabled={isBusy} onClick={onCheck} type="button">
            {isChecking ? '检查中...' : isAutoCheckEnabled ? '立即检查' : '手动检查'}
          </button>}
          {isOwnedBook && <button className="font-medium underline decoration-current/25 underline-offset-4 hover:decoration-current" onClick={onEditSource} type="button">重新读取资料</button>}
          {isOwnedBook && hasUpdate && !hasTranslationJob && (
            <button className="inline-flex items-center gap-1 font-semibold text-accent underline decoration-current/25 underline-offset-4 hover:decoration-current disabled:opacity-50 dark:text-peach" disabled={isBusy} onClick={onTranslate} type="button">
              <Sparkles className="h-3.5 w-3.5" />{isTranslating ? '正在启动...' : '翻译更新'}
            </button>
          )}
          {isOwnedBook && hasUpdate && (
            <button className="font-medium underline decoration-current/25 underline-offset-4 hover:decoration-current disabled:opacity-50" disabled={isBusy} onClick={onAcknowledge} type="button">
              {isAcknowledging ? '处理中...' : '标记已处理'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{details}</p>
      {statusError && <p className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-300">上次检查失败：{statusError}</p>}
    </div>
  );
}

function BookTranslationStatusStrip({ errorMessage, processingAction, isReviewLoading = false, job, onConcurrencyChange, onPause, onResume, onRetry, onReview }: {
  errorMessage: string;
  isReviewLoading?: boolean;
  processingAction: BookTranslationAction | null;
  job: WholeBookTranslationJob;
  onConcurrencyChange: (value: number) => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onReview: () => void;
}) {
  const isActive = job.status === 'queued' || job.status === 'processing' || job.status === 'waiting_quota';
  const isPaused = job.status === 'paused';
  const isPausePending = job.status === 'processing' && job.pause_requested;
  const isBusy = processingAction !== null;
  const statusLabel = getWholeBookTranslationStatusLabel(job);
  const processingLabel = processingAction === null ? null : {
    concurrency: '正在调整并发…',
    pause: '正在请求暂停…',
    resume: isPausePending ? '正在取消暂停…' : '正在继续翻译…',
    retry: '正在从断点重试…',
  }[processingAction];
  const Icon = job.status === 'review' ? BookOpen : job.status === 'failed' ? AlertCircle : job.status === 'ready' ? CheckCircle2 : job.status === 'waiting_quota' ? Clock3 : isPaused ? Pause : job.status === 'rejected' ? X : LoaderCircle;

  return (
    <div className="mt-3 max-w-[820px] border-l-2 border-pink-300 pl-4 text-stone-700 dark:border-pink-400/40 dark:text-night-copy" id="book-translation-status" aria-busy={isBusy}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Icon className={cn('h-4 w-4 text-accent dark:text-peach', (job.status === 'queued' || job.status === 'processing') && !isPaused && 'animate-spin')} />
          {statusLabel}
        </p>
        {(isActive || isPaused) && (
          <span className="text-xs tabular-nums text-stone-500 dark:text-stone-400">
            {job.completed_chapters}/{job.total_chapters} 话 · {job.progress}%
          </span>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {(isActive || isPaused) && (
            <label className="inline-flex items-center gap-1 text-stone-500 dark:text-stone-400">
              并发
              <select
                aria-label={`《${job.title}》并发请求数`}
                className="h-7 border-0 bg-transparent px-1 font-medium text-stone-700 outline-none focus:text-accent disabled:opacity-50 dark:text-night-copy"
                disabled={isBusy}
                onChange={(event) => onConcurrencyChange(Number(event.target.value))}
                value={job.request_concurrency}
              >
                {job.request_concurrency > job.max_concurrency && <option disabled value={job.request_concurrency}>{job.request_concurrency}（超出当前上限）</option>}
                {Array.from({ length: job.max_concurrency }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          {isActive && !isPausePending && <button className="font-medium text-stone-600 underline decoration-current/25 underline-offset-4 disabled:opacity-50 dark:text-night-soft" disabled={isBusy} onClick={onPause} type="button">暂停</button>}
          {(isPaused || isPausePending) && <button className="font-medium text-accent underline decoration-current/25 underline-offset-4 disabled:opacity-50 dark:text-peach" disabled={isBusy} onClick={onResume} type="button">{isPausePending ? '取消暂停' : '继续'}</button>}
          {(job.status === 'failed' || job.status === 'waiting_quota') && <button className="font-medium text-accent underline decoration-current/25 underline-offset-4 disabled:opacity-50 dark:text-peach" disabled={isBusy} onClick={onRetry} type="button">{job.status === 'waiting_quota' ? '立即重试' : '从断点重试'}</button>}
          {job.status === 'review' && <button aria-busy={isReviewLoading} className="inline-flex items-center gap-1 font-semibold text-accent underline decoration-current/25 underline-offset-4 disabled:cursor-wait disabled:opacity-60 dark:text-peach" disabled={isReviewLoading} onClick={onReview} type="button"><BookOpen className="h-3.5 w-3.5" />{isReviewLoading ? '正在读取译稿…' : '查看并审核'}</button>}
        </div>
      </div>
      {processingLabel && <p className="mt-1 text-xs text-accent dark:text-peach" role="status">{processingLabel}</p>}
      <p className="mt-1 break-words text-xs leading-5 text-stone-500 [overflow-wrap:anywhere] dark:text-stone-400">{getWholeBookTranslationStatusMessage(job)}</p>
      {job.job_kind === 'whole_book' && job.book_id && job.status !== 'ready' && (
        <p className="mt-1 text-xs leading-5 text-accent dark:text-peach">当前目录中的章节可直接阅读；新译文经校验并发布后会更新目录。</p>
      )}
      {(job.completed_chapters > 0 || job.quality_status === 'warning') && (
        <p className={cn('mt-0.5 text-[11px]', job.quality_status === 'warning' ? 'text-amber-600 dark:text-amber-300' : job.quality_status === 'pending' ? 'text-stone-500 dark:text-stone-400' : 'text-emerald-600 dark:text-emerald-300')}>
          {getWholeBookTranslationQualityMessage(job)}
        </p>
      )}
      {(isActive || isPaused) && (
        <div className="mt-2 h-1 overflow-hidden bg-stone-200/70 dark:bg-white/[0.08]">
          <div className="h-full bg-pink-400 transition-[width] duration-500" style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {errorMessage && <p role="alert" className="mt-1 break-words text-xs leading-5 text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{errorMessage}</p>}
    </div>
  );
}

function getAutomaticSourceCheckLabel(book: Book) {
  if (book.sourceScheduleTime && book.sourceScheduleTimezone === 'Asia/Tokyo') {
    return `每 6 小时检查 · ${book.sourceScheduleTime}（日本时间）优先`;
  }
  if (book.sourceScheduleTime) {
    return `每 6 小时检查 · ${book.sourceScheduleTime}（源站时间）优先`;
  }
  return '每 6 小时检查';
}

function BookColophon({ book }: { book: Book }) {
  const characterCountLabel = formatCharacterCount(book.characterCount);
  const formatLabel = book.fileExt?.replace(/^\./, '').toUpperCase();

  const entries: Array<{ label: string; value: ReactNode }> = [
    { label: '类型', value: kindLabel[book.kind] },
    characterCountLabel ? { label: '字数', value: characterCountLabel } : null,
    book.chapterCount ? { label: '章节', value: `${book.chapterCount} 章` } : null,
    !book.chapterCount && book.pageCount ? { label: '页数', value: `${book.pageCount} 页` } : null,
    formatLabel ? { label: '格式', value: formatLabel } : null,
    book.fileSize ? { label: '大小', value: formatFileSize(book.fileSize) } : null,
    { label: '上传', value: formatCompactDate(book.createdAt) },
    book.rating && book.rating > 0 ? { label: '评分', value: `${book.rating} / 10` } : null,
    { label: '可见', value: book.readersLabel ?? '仅自己' },
    book.publicationStatus ? { label: '状态', value: book.publicationStatus === 'ongoing' ? '连载中' : '已完结' } : null,
  ].filter(Boolean) as Array<{ label: string; value: ReactNode }>;

  return (
    <dl className="book-detail-colophon mt-4 grid max-w-[820px] grid-cols-2 gap-x-5 sm:grid-cols-3 xl:grid-cols-4">
      {entries.map(({ label, value }) => (
        <div className={cn('flex items-baseline justify-between gap-4 border-b py-2', HAIRLINE)} key={label}>
          <dt className={cn('shrink-0', LABEL)}>{label}</dt>
          <dd className="min-w-0 truncate text-right text-sm tabular-nums text-stone-800 dark:text-night-copy">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BookDescription({ description }: { description: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const normalizedDescription = description?.trim() ?? '';

  if (!normalizedDescription) {
    return <p className="mt-4 text-sm text-stone-400 dark:text-stone-500">暂无简介</p>;
  }

  const isLong = normalizedDescription.length > 180 || normalizedDescription.split('\n').length > 6;

  return (
    <div className="mt-4">
      <p className={cn('whitespace-pre-wrap text-sm leading-7 text-stone-600 dark:text-night-soft', isLong && !isExpanded && 'line-clamp-6')}>
        {normalizedDescription}
      </p>
      {isLong && (
        <button
          className="mt-2 text-xs font-medium text-accent transition hover:text-accent-deep dark:text-peach"
          onClick={() => setIsExpanded((current) => !current)}
          type="button"
        >
          {isExpanded ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  );
}

function formatCharacterCount(characterCount?: number): string | null {
  if (!characterCount || characterCount <= 0) {
    return null;
  }
  if (characterCount >= 10000) {
    return `${(characterCount / 10000).toFixed(1)} 万字`;
  }
  return `${characterCount} 字`;
}

function PublicShareStatusCard({ book, isOwnedBook }: { book: Book; isOwnedBook: boolean }) {
  const status = getPublicShareStatus(book.publicStatus);
  const metadata = [
    book.ownerNickname ? `分享者：${book.ownerNickname}` : null,
    book.publicApprovedAt ? `公开于：${formatCompactDate(book.publicApprovedAt)}` : null,
    book.commentCount ? `${book.commentCount} 条评论` : null,
    book.publicDownloadAllowed === false ? '仅在线阅读' : '允许下载原文件',
  ].filter(Boolean) as string[];

  return (
    <div className={cn('min-w-0 border-l-2 pl-4', status.className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Globe2 className="h-4 w-4" />
          {status.label}
        </p>
        <span className="text-xs opacity-80">{isOwnedBook ? '我的书' : '公共阅读'}</span>
      </div>
      {(metadata.length > 0 || book.publicShareNote || book.publicSourceNote) && (
        <div className="mt-1.5 space-y-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
          {metadata.length > 0 && <p>{metadata.join(' · ')}</p>}
          {book.publicShareNote && <p className="whitespace-pre-wrap">{book.publicShareNote}</p>}
          {book.publicSourceNote && <p className="whitespace-pre-wrap">来源：{book.publicSourceNote}</p>}
        </div>
      )}
    </div>
  );
}

function getPublicShareStatus(status: Book['publicStatus']) {
  if (status === 'pending') {
    return {
      className: 'border-amber-400/70 text-amber-700 dark:text-amber-300',
      description: '管理员通过后，其他登录用户就能在公共书库里阅读和评论。',
      label: '公共书库审核中',
    };
  }
  if (status === 'public') {
    return {
      className: 'border-emerald-400/70 text-emerald-700 dark:text-emerald-300',
      description: '这本书已经进入公共书库。拥有者可以随时取消公开。',
      label: '已公开到公共书库',
    };
  }
  if (status === 'rejected') {
    return {
      className: 'border-red-400/70 text-red-600 dark:text-red-300',
      description: '上次公开申请未通过。整理来源和简介后可以重新提交。',
      label: '公开申请未通过',
    };
  }
  return {
    className: 'border-stone-300 text-stone-600 dark:border-white/20 dark:text-night-soft',
    description: '当前只在你的私人书架里。点击分享按钮后会先进入管理员审核。',
    label: '私人书库',
  };
}

function getPublicShareActionLabel(status: Book['publicStatus'], isUpdating: boolean): string {
  if (isUpdating) {
    return '更新中';
  }
  if (status === 'pending') {
    return '取消审核';
  }
  if (status === 'public') {
    return '取消公开';
  }
  return '分享到公共书库';
}

function getPublicShareMessage(status: Book['publicStatus']): string {
  if (status === 'pending') {
    return '已提交管理员审核';
  }
  if (status === 'public') {
    return '已加入公共书库';
  }
  return '已改回私有书库';
}

function formatCompactDate(value: string): string {
  const date = parseAppDate(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function readCommentsVisibilityPreference(): boolean {
  try {
    return window.localStorage.getItem('aisu-bookhouse:show-comments') === 'true';
  } catch {
    return false;
  }
}

function saveCommentsVisibilityPreference(value: boolean): void {
  try {
    window.localStorage.setItem('aisu-bookhouse:show-comments', String(value));
  } catch {
    // Ignore storage failures; the in-memory toggle still works for this page.
  }
}
