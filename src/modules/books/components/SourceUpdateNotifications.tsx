import { Bell, BookOpen, Check, CheckCheck, Clock, LoaderCircle, Pause, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { getBookDetailPath, getTranslationTaskPath, ROUTES } from '../../../config/routes';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { formatDate } from '../../../shared/utils/formatDate';
import { cn } from '../../../shared/utils/cn';
import { isAbortError } from '../../../shared/utils/abortError';
import { startPolling } from '../../../shared/utils/polling';
import { BookCover } from './BookCover';
import { reconcileTranslationNotification, removeAcknowledgedSourceUpdate } from '../services/notificationReconciliation';
import { getNotificationPanelPosition, type NotificationPanelPosition } from '../services/notificationPanelPosition';
import {
  acknowledgeWholeBookTranslation,
  deleteWholeBookTranslation,
  getWholeBookTranslationStatusMessage,
  getTranslationJobNotifications,
  retryWholeBookTranslation,
  TRANSLATION_JOBS_CHANGED_EVENT,
  TRANSLATED_BOOKS_CHANGED_EVENT,
  type TranslationJobNotifications,
} from '../../uploads/services/wholeBookTranslationService';
import {
  acknowledgeAllBookSourceUpdates,
  acknowledgeBookSourceUpdate,
  getSourceUpdateNotifications,
  invalidateBookListCache,
  SOURCE_UPDATE_NOTIFICATIONS_CHANGED_EVENT,
  type SourceUpdateNotifications,
} from '../services/bookService';

const EMPTY_NOTIFICATIONS: SourceUpdateNotifications = {
  bookCount: 0,
  episodeCount: 0,
  items: [],
};

const EMPTY_TRANSLATION_NOTIFICATIONS: TranslationJobNotifications = { active_count: 0, items: [], unread_count: 0 };

const REFRESH_INTERVAL_MS = 15 * 1000;
export function SourceUpdateNotifications({ sessionId }: { sessionId?: string }) {
  const [data, setData] = useState<SourceUpdateNotifications>(EMPTY_NOTIFICATIONS);
  const [translationData, setTranslationData] = useState<TranslationJobNotifications>(EMPTY_TRANSLATION_NOTIFICATIONS);
  const [errorMessage, setErrorMessage] = useState('');
  const [refreshErrorMessage, setRefreshErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(Boolean(sessionId));
  const location = useLocation();
  const navigationState = createCollectionLinkState(location);
  const [isOpen, setIsOpen] = useState(false);
  const [isAcknowledgingAll, setIsAcknowledgingAll] = useState(false);
  const [processingBookId, setProcessingBookId] = useState<string | null>(null);
  const [processingTranslationId, setProcessingTranslationId] = useState<string | null>(null);
  const [translationAction, setTranslationAction] = useState<'acknowledge' | 'retry' | 'delete' | null>(null);
  const [panelPosition, setPanelPosition] = useState<NotificationPanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const publishedSignatureRef = useRef('');
  const refreshRequestIdRef = useRef(0);
  const mutationRevisionRef = useRef({ source: 0, translation: 0 });
  // React state disables controls after rendering; refs also fence same-tick clicks.
  const actionControllersRef = useRef<{ source: AbortController | null; translation: AbortController | null }>({ source: null, translation: null });

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++refreshRequestIdRef.current;
    if (!sessionId) {
      setData(EMPTY_NOTIFICATIONS);
      setTranslationData(EMPTY_TRANSLATION_NOTIFICATIONS);
      publishedSignatureRef.current = '';
      setErrorMessage('');
      setIsLoading(false);
      return;
    }

    const revision = { ...mutationRevisionRef.current };
    const isCurrent = () => !signal?.aborted && requestId === refreshRequestIdRef.current;
    const errors: string[] = [];
    const recordFailure = (error: unknown, kind: 'source' | 'translation') => {
      if (!isCurrent() || revision[kind] !== mutationRevisionRef.current[kind] || isAbortError(error)) return;
      errors.push(`${kind === 'source' ? '原作更新' : '翻译通知'}加载失败：${error instanceof Error ? error.message : '请稍后重试'}`);
      setRefreshErrorMessage(errors.join('；'));
    };
    setIsLoading(true);
    setRefreshErrorMessage('');
    try {
      await Promise.all([
        getSourceUpdateNotifications(signal).then((sourceUpdates) => {
          if (isCurrent() && revision.source === mutationRevisionRef.current.source) setData(sourceUpdates);
        }).catch((error: unknown) => recordFailure(error, 'source')),
        getTranslationJobNotifications(signal).then((translationUpdates) => {
          if (!isCurrent() || revision.translation !== mutationRevisionRef.current.translation) return;
          setTranslationData(translationUpdates);
          const published = translationUpdates.items.filter((job) => job.book_id);
          const signature = JSON.stringify(published.map((job) => [job.book_id, job.completed_chapters, job.status === 'ready']).sort());
          if (publishedSignatureRef.current !== signature) {
            publishedSignatureRef.current = signature;
            invalidateBookListCache();
            window.dispatchEvent(new Event(TRANSLATED_BOOKS_CHANGED_EVENT));
          }
        }).catch((error: unknown) => recordFailure(error, 'translation')),
      ]);
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, [sessionId]);

  useLayoutEffect(() => () => {
    Object.values(actionControllersRef.current).forEach((controller) => controller?.abort());
    actionControllersRef.current = { source: null, translation: null };
  }, [sessionId]);

  useEffect(() => {
    // Clear the previous account's badge immediately. The next polling run
    // will load the new account, while the request id prevents an old response
    // from repopulating this component during the transition.
    refreshRequestIdRef.current += 1;
    setData(EMPTY_NOTIFICATIONS);
    setTranslationData(EMPTY_TRANSLATION_NOTIFICATIONS);
    setErrorMessage('');
    setIsLoading(Boolean(sessionId));
    setRefreshErrorMessage('');
    setIsOpen(false);
    mutationRevisionRef.current = { source: 0, translation: 0 };
    setProcessingBookId(null);
    setProcessingTranslationId(null);
    setTranslationAction(null);
    setIsAcknowledgingAll(false);
    publishedSignatureRef.current = '';
  }, [sessionId]);

  useEffect(() => {
    return startPolling(refresh, {
      intervalMs: REFRESH_INTERVAL_MS,
      events: ['focus', SOURCE_UPDATE_NOTIFICATIONS_CHANGED_EVENT, TRANSLATION_JOBS_CHANGED_EVENT],
    });
  }, [refresh]);

  useEffect(() => { setIsOpen(false); }, [location.key]);

  const closePanel = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const isPanelPositioned = panelPosition !== null;
  useEffect(() => {
    if (isOpen && isPanelPositioned) panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), a[href]')?.focus({ preventScroll: true });
  }, [isOpen, isPanelPositioned]);

  useEffect(() => {
    if (isOpen && document.activeElement === document.body) {
      panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), a[href]')?.focus({ preventScroll: true });
    }
  }, [data.items, errorMessage, isAcknowledgingAll, isOpen, processingBookId, processingTranslationId, translationData.items]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault();
        closePanel();
      }
    };
    const handleOutside = (event: Event) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('focusin', handleOutside);
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('focusin', handleOutside);
    };
  }, [closePanel, isOpen]);

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    if (!trigger.getClientRects().length) {
      setIsOpen(false);
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const next = getNotificationPanelPosition(rect, {
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
      offsetLeft: viewport?.offsetLeft ?? 0,
      offsetTop: viewport?.offsetTop ?? 0,
    });

    setPanelPosition((current) => current?.left === next.left && current.maxHeight === next.maxHeight && current.top === next.top && current.width === next.width
      ? current : next);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPanelPosition(null);
      return undefined;
    }

    let frame = 0;
    const schedulePosition = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; updatePanelPosition(); });
    };
    const handleScroll = (event: Event) => {
      // Scrolling the notification list cannot move its anchor. Only the
      // document or an ancestor of the trigger needs a position update.
      const target = event.target;
      if (target === window || (target instanceof Node && target.contains(triggerRef.current))) schedulePosition();
    };
    updatePanelPosition();
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('scroll', handleScroll, true);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedulePosition);
      window.removeEventListener('scroll', handleScroll, true);
      window.visualViewport?.removeEventListener('resize', schedulePosition);
      window.visualViewport?.removeEventListener('scroll', schedulePosition);
    };
  }, [isOpen, updatePanelPosition]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!isOpen || !panel || !panelPosition) return;
    const body = panel.querySelector('.source-update-panel-body');
    let frame = 0;
    const update = () => {
      frame = 0;
      const fixedHeight = Array.from(panel.children).filter((element) => element !== body)
        .reduce((height, element) => height + Math.max(element.scrollHeight, element.getBoundingClientRect().height), 0);
      // When the header and actions leave too little room, let the whole
      // panel scroll. Keeping only the list scrollable can shrink it to zero.
      panel.dataset.viewportCompact = String(panelPosition.maxHeight < fixedHeight + 120);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    for (const element of panel.children) observer.observe(element);
    update();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [data.items.length, errorMessage, isOpen, panelPosition, refreshErrorMessage]);

  const badgeCount = data.bookCount + translationData.unread_count;
  const badgeLabel = useMemo(() => badgeCount > 99 ? '99+' : String(badgeCount), [badgeCount]);
  const notificationSummary = useMemo(() => {
    const parts: string[] = [];
    if (translationData.active_count > 0) parts.push(`${translationData.active_count} 个翻译中`);
    if (translationData.unread_count > 0) parts.push(`${translationData.unread_count} 个翻译结果`);
    if (data.bookCount > 0) parts.push(`${data.bookCount} 部作品更新 · 新增 ${data.episodeCount} 话`);
    return parts.length > 0 ? parts.join(' · ') : isLoading ? '正在检查通知…' : refreshErrorMessage ? '部分通知暂时无法加载' : '暂无待处理通知';
  }, [data.bookCount, data.episodeCount, translationData.active_count, translationData.unread_count, isLoading, refreshErrorMessage]);

  const handleTranslationAction = async (jobId: string, action: 'acknowledge' | 'retry') => {
    if (actionControllersRef.current.translation) return;
    const controller = new AbortController();
    actionControllersRef.current.translation = controller;
    setProcessingTranslationId(jobId);
    setTranslationAction(action);
    setErrorMessage('');
    try {
      const updated = action === 'retry' ? await retryWholeBookTranslation(jobId, controller.signal) : await acknowledgeWholeBookTranslation(jobId, controller.signal);
      if (controller.signal.aborted) return;
      mutationRevisionRef.current.translation += 1;
      setTranslationData((current) => reconcileTranslationNotification(current, jobId, updated));
    } catch (error: unknown) {
      if (!controller.signal.aborted && !isAbortError(error)) setErrorMessage(error instanceof Error ? error.message : '翻译任务处理失败');
    } finally {
      if (actionControllersRef.current.translation === controller) {
        actionControllersRef.current.translation = null;
        if (!controller.signal.aborted) {
          setProcessingTranslationId(null);
          setTranslationAction(null);
        }
      }
    }
  };

  const handleTranslationDelete = async (job: TranslationJobNotifications['items'][number]) => {
    if (actionControllersRef.current.translation) return;
    const confirmed = window.confirm(job.status === 'paused'
      ? `放弃《${job.title}》的后续翻译？\n\n已完成并加入书架的 ${job.completed_chapters} 话会保留；翻译断点、通知和任务记录将删除。`
      : `删除《${job.title}》的翻译记录？\n\n书架里的图书不会被删除。`);
    if (!confirmed) return;
    const controller = new AbortController();
    actionControllersRef.current.translation = controller;
    setProcessingTranslationId(job.id);
    setTranslationAction('delete');
    setErrorMessage('');
    try {
      await deleteWholeBookTranslation(job.id, controller.signal);
      if (controller.signal.aborted) return;
      mutationRevisionRef.current.translation += 1;
      setTranslationData((current) => reconcileTranslationNotification(current, job.id));
    } catch (error: unknown) {
      if (!controller.signal.aborted && !isAbortError(error)) setErrorMessage(error instanceof Error ? error.message : '翻译记录删除失败');
    } finally {
      if (actionControllersRef.current.translation === controller) {
        actionControllersRef.current.translation = null;
        if (!controller.signal.aborted) {
          setProcessingTranslationId(null);
          setTranslationAction(null);
        }
      }
    }
  };

  const handleAcknowledge = async (bookId: string) => {
    if (actionControllersRef.current.source) return;
    const controller = new AbortController();
    actionControllersRef.current.source = controller;
    setProcessingBookId(bookId);
    setErrorMessage('');
    try {
      await acknowledgeBookSourceUpdate(bookId, controller.signal);
      if (controller.signal.aborted) return;
      mutationRevisionRef.current.source += 1;
      setData((current) => removeAcknowledgedSourceUpdate(current, bookId));
    } catch (error: unknown) {
      if (!controller.signal.aborted && !isAbortError(error)) setErrorMessage(error instanceof Error ? error.message : '更新状态处理失败');
    } finally {
      if (actionControllersRef.current.source === controller) {
        actionControllersRef.current.source = null;
        if (!controller.signal.aborted) setProcessingBookId(null);
      }
    }
  };

  const handleAcknowledgeAll = async () => {
    if (actionControllersRef.current.source || !data.items.length) return;
    const controller = new AbortController();
    actionControllersRef.current.source = controller;
    setIsAcknowledgingAll(true);
    setErrorMessage('');
    try {
      await acknowledgeAllBookSourceUpdates(controller.signal);
      if (controller.signal.aborted) return;
      mutationRevisionRef.current.source += 1;
      setData(EMPTY_NOTIFICATIONS);
    } catch (error: unknown) {
      if (!controller.signal.aborted && !isAbortError(error)) setErrorMessage(error instanceof Error ? error.message : '全部更新状态处理失败');
    } finally {
      if (actionControllersRef.current.source === controller) {
        actionControllersRef.current.source = null;
        if (!controller.signal.aborted) setIsAcknowledgingAll(false);
      }
    }
  };

  if (!sessionId) return null;

  return (
    <div className="source-update-notifications relative shrink-0">
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={isOpen ? 'notification-panel' : undefined}
        aria-label={badgeCount > 0 ? `通知，${notificationSummary}` : '通知'}
        className={cn(
          'topbar-notifications-toggle relative grid h-10 w-10 shrink-0 place-items-center text-ink/60 transition duration-300 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 dark:text-night-soft dark:hover:text-accent-soft sm:h-11 sm:w-11',
        )}
        onClick={() => {
          setIsOpen((current) => !current);
          if (!isOpen) void refresh();
        }}
        title="更新通知"
        type="button"
        ref={triggerRef}
      >
        <Bell className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
        {badgeCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-accent-strong px-1 text-[9px] font-bold leading-none text-white ring-2 ring-[#f4efe7] dark:ring-night-surface">
            {badgeLabel}
          </span>
        )}
      </button>
      {isOpen && panelPosition && createPortal(
        <div
          aria-label="通知"
          id="notification-panel"
          tabIndex={-1}
          className="source-update-panel fixed z-[80] flex flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-shell shadow-[0_24px_70px_rgba(28,25,23,0.18)] dark:border-white/10 dark:bg-[#211d25] dark:shadow-[0_24px_70px_rgba(0,0,0,0.5)]"
          ref={panelRef}
          role="dialog"
          style={panelPosition}
          onKeyDown={(event) => {
            if (event.key !== 'Tab' || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
            const actions = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
            if (event.shiftKey && event.target === actions[0]) {
              event.preventDefault();
              closePanel();
            } else if (!event.shiftKey && event.target === actions.at(-1)) {
              // A portal sits at the end of body; resume the normal tab order
              // beside the notification trigger instead of wrapping the page.
              closePanel();
            }
          }}
        >
          <div className="source-update-panel-header flex items-center justify-between gap-3 border-b border-stone-200/70 px-4 py-3.5 dark:border-white/10">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-stone-950 dark:text-night-ink">通知</h2>
              <p className="mt-0.5 line-clamp-2 text-xs text-stone-500 dark:text-stone-400">
                {notificationSummary}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                aria-label="刷新更新通知"
                aria-disabled={isLoading}
                className="grid h-9 w-9 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-accent aria-disabled:opacity-50 dark:hover:bg-white/10"
                onClick={() => { if (!isLoading) void refresh(); }}
                title="刷新"
                type="button"
              >
                <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
              </button>
              <button
                aria-label="关闭更新通知"
                className="grid h-9 w-9 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-white/10 dark:hover:text-night-ink"
                onClick={closePanel}
                title="关闭"
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="source-update-panel-body min-h-0 overflow-y-auto overscroll-contain reader-scrollbar">
            {translationData.items.map((job) => {
              const isRetryable = job.status === 'failed' || job.status === 'waiting_quota';
              const hasTrailingAction = job.status === 'paused' || ((job.status === 'ready' || job.status === 'review') && !job.acknowledged);
              const isProcessing = processingTranslationId === job.id;
              const statusMessage = job.book_id && job.status === 'review'
                ? `${job.completed_chapters} 话更新译稿待确认，点击查看`
                : job.book_id && job.status === 'ready'
                  ? (job.job_kind === 'source_update' ? '更新译文已加入原书' : '整本精翻已完成，打开图书')
                  : getWholeBookTranslationStatusMessage(job);
              const content = <>
                <span className="block break-words text-sm font-medium text-stone-900 [overflow-wrap:anywhere] dark:text-night-ink">{job.title}</span>
                <span className={cn('mt-1 block break-words text-xs leading-5 [overflow-wrap:anywhere]',
                  job.status === 'failed' ? 'text-red-600 dark:text-red-300'
                    : job.status === 'waiting_quota' ? 'text-amber-600 dark:text-amber-300'
                      : job.status === 'review' ? 'text-accent dark:text-peach'
                        : job.status === 'ready' ? 'text-emerald-600 dark:text-emerald-300'
                          : 'text-stone-500 dark:text-stone-400',
                )}>{job.status === 'failed' ? `翻译失败：${statusMessage}` : statusMessage}</span>
                {job.status !== 'ready' && job.status !== 'review' && <span className="mt-0.5 block text-[11px] tabular-nums text-stone-400">已完成 {job.completed_chapters}/{job.total_chapters} 话 · {job.progress}%</span>}
              </>;
              return (
              <div aria-busy={isProcessing} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-stone-100 px-4 py-3 dark:border-white/[0.07]" key={job.id}>
                {job.status === 'processing' || job.status === 'queued'
                  ? <LoaderCircle className="h-5 w-5 shrink-0 animate-spin text-pink-400" />
                  : job.status === 'waiting_quota'
                    ? <Clock className="h-5 w-5 shrink-0 text-amber-500" />
                  : job.status === 'paused'
                    ? <Pause className="h-5 w-5 shrink-0 text-stone-400" />
                  : job.status === 'review'
                    ? <BookOpen className="h-5 w-5 shrink-0 text-pink-500" />
                  : job.status === 'ready'
                    ? <Check className="h-5 w-5 shrink-0 text-emerald-500" />
                    : <X className="h-5 w-5 shrink-0 text-red-500" />}
                <Link className={cn('min-w-0', !hasTrailingAction && 'col-span-2')} onClick={() => setIsOpen(false)} state={navigationState} to={job.book_id && (job.status === 'ready' || job.status === 'review')
                  ? `${getBookDetailPath(job.book_id)}${job.status === 'review' ? `?translationReview=${encodeURIComponent(job.id)}` : ''}`
                  : getTranslationTaskPath(job.id)}>
                  {content}
                </Link>
                {isRetryable ? (
                  <div className="col-span-2 col-start-2 flex flex-wrap items-center justify-end gap-1">
                    <button aria-busy={isProcessing && translationAction === 'retry'} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-accent disabled:opacity-50" disabled={processingTranslationId !== null} onClick={() => void handleTranslationAction(job.id, 'retry')} type="button">{isProcessing && translationAction === 'retry' ? <><LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />重试中…</> : job.status === 'waiting_quota' ? '立即重试' : '重试'}</button>
                    <button aria-busy={isProcessing && translationAction === 'delete'} aria-label={`删除《${job.title}》的翻译记录`} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-stone-400 transition hover:text-red-500 disabled:opacity-50" disabled={processingTranslationId !== null} onClick={() => void handleTranslationDelete(job)} title="删除翻译记录" type="button">{isProcessing && translationAction === 'delete' ? <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button>
                  </div>
                ) : job.status === 'paused' ? (
                  <button aria-busy={isProcessing} aria-label={`放弃《${job.title}》的后续翻译`} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-stone-400 transition hover:text-red-500 disabled:opacity-50" disabled={processingTranslationId !== null} onClick={() => void handleTranslationDelete(job)} title="放弃后续翻译" type="button">{isProcessing ? <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button>
                ) : ((job.status === 'ready' || job.status === 'review') && !job.acknowledged) ? (
                  <button aria-busy={isProcessing} aria-label={`关闭《${job.title}》的翻译通知`} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-stone-400 transition hover:text-stone-700 disabled:opacity-50 dark:hover:text-night-ink" disabled={processingTranslationId !== null} onClick={() => void handleTranslationAction(job.id, 'acknowledge')} title="关闭通知" type="button">{isProcessing ? <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}</button>
                ) : null}
              </div>
              );
            })}
            {data.items.map((book) => (
              <div className="source-update-book-row flex items-center gap-3 border-b border-stone-100 px-4 py-3 last:border-b-0 dark:border-white/[0.07]" key={book.id}>
                <Link className="flex min-w-0 flex-1 items-center gap-3" onClick={() => setIsOpen(false)} state={navigationState} to={getBookDetailPath(book.id)}>
                  <BookCover book={book} size="xs" />
                  <span className="min-w-0 flex-1">
                    <span title={book.title} className="block truncate text-sm font-medium text-stone-900 dark:text-night-ink">{book.title}</span>
                    <span className="mt-1 block text-xs text-accent dark:text-peach">原作新增 {book.sourceUpdateCount ?? 0} 话</span>
                    {(book.sourceEpisodeCount !== undefined || book.sourceCheckedAt) && (
                      <span className="mt-0.5 block text-[11px] text-stone-400 dark:text-stone-500">
                        {book.sourceEpisodeCount !== undefined ? `原作共 ${book.sourceEpisodeCount} 话` : ''}
                        {book.sourceEpisodeCount !== undefined && book.sourceCheckedAt ? ' · ' : ''}
                        {book.sourceCheckedAt ? `${formatDate(book.sourceCheckedAt)} 检查` : ''}
                      </span>
                    )}
                  </span>
                </Link>
                <button
                  aria-label={`关闭《${book.title}》的此次更新提醒`}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-stone-500 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50 dark:text-stone-400 dark:hover:bg-emerald-950/30 dark:hover:text-emerald-300"
                  disabled={processingBookId !== null || isAcknowledgingAll}
                  onClick={() => void handleAcknowledge(book.id)}
                  title="关闭此次更新提醒"
                  type="button"
                >
                  {processingBookId === book.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  <span>{processingBookId === book.id ? '处理中' : '关闭提醒'}</span>
                </button>
              </div>
            ))}
            {!data.items.length && !translationData.items.length && isLoading && <p className="px-5 py-9 text-center text-sm text-stone-500 dark:text-night-soft" role="status">正在加载通知…</p>}
            {!data.items.length && !translationData.items.length && !isLoading && !refreshErrorMessage && (
              <div className="px-5 py-9 text-center">
                <Bell className="mx-auto h-6 w-6 text-stone-300 dark:text-stone-600" />
                <p className="mt-3 text-sm font-medium text-stone-700 dark:text-night-copy">暂时没有小说更新</p>
                <p className="mt-1 text-xs leading-5 text-stone-400 dark:text-stone-500">连载作品每 6 小时检查一次；源站标注更新时间时会按该时间优先检查。</p>
              </div>
            )}
          </div>
          <Link className="flex min-h-11 shrink-0 items-center justify-center border-t border-stone-200/70 px-4 text-sm font-medium text-accent dark:border-white/10 dark:text-peach" onClick={() => setIsOpen(false)} to={ROUTES.translations}>全部翻译任务</Link>
          {data.items.length > 1 && (
            <div className="border-t border-stone-200/70 px-4 py-2.5 dark:border-white/10">
              <button
                className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-night-ink"
                disabled={processingBookId !== null || isAcknowledgingAll}
                onClick={() => void handleAcknowledgeAll()}
                type="button"
              >
                {isAcknowledgingAll ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
                {isAcknowledgingAll ? '正在处理' : '关闭全部更新提醒'}
              </button>
            </div>
          )}
          {refreshErrorMessage && <div className="min-h-0 shrink overflow-y-auto overscroll-contain border-t border-red-100 bg-red-50 px-4 py-2.5 text-xs text-red-600 reader-scrollbar dark:border-red-950/50 dark:bg-red-950/20 dark:text-red-300" style={{ maxHeight: panelPosition.maxHeight * 0.45 }} role="alert"><p className="break-words leading-5">{refreshErrorMessage}</p><button className="mt-1 min-h-11 font-medium underline underline-offset-4" onClick={() => void refresh()} type="button">重试加载通知</button></div>}
          {errorMessage && <p role="alert" tabIndex={0} className="min-h-0 shrink overflow-y-auto overscroll-contain break-words border-t border-red-100 bg-red-50 px-4 py-2.5 text-xs text-red-600 dark:border-red-950/50 dark:bg-red-950/20 dark:text-red-300" style={{ maxHeight: panelPosition.maxHeight * 0.45 }}>{errorMessage}</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}
