import { LoaderCircle, MessageCircle, Send, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSession } from '../../app/SessionContext';
import { Button } from '../../shared/components/Button';
import { UserAvatar } from '../../shared/components/UserAvatar';
import { isAbortError } from '../../shared/utils/abortError';
import { formatDate } from '../../shared/utils/formatDate';
import { createPublicComment, deletePublicComment, getPublicComments } from './commentService';
import type { CommentTargetType } from './types';
import { PaginatedRequestGate } from '../library/services/paginatedBookRequests';
import { EMPTY_COMMENT_COLLECTION, addCreatedComment, applyCommentPage, getCommentCollectionItems, hasCommentPageDrift, loadCommentWindow, removeDeletedComment } from './commentCollection';

interface PublicCommentsPanelProps {
  bookId: string;
  isVisible: boolean;
  onVisibilityChange: (isVisible: boolean) => void;
  targetIndex?: number;
  targetLabel?: string;
  targetType: CommentTargetType;
}

export function PublicCommentsPanel(props: PublicCommentsPanelProps) {
  const { session } = useSession();
  return <PublicCommentThread {...props} key={JSON.stringify([session?.id, props.bookId, props.targetType, props.targetIndex])} />;
}

function PublicCommentThread({ bookId, isVisible, onVisibilityChange, targetIndex, targetLabel, targetType }: PublicCommentsPanelProps) {
  const { session } = useSession();
  const [collection, setCollection] = useState(EMPTY_COMMENT_COLLECTION);
  const comments = getCommentCollectionItems(collection);
  const commentTotal = collection.total;
  const [draft, setDraft] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [loadErrorMode, setLoadErrorMode] = useState<'replace' | 'append'>('replace');
  const [submitError, setSubmitError] = useState('');
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [statusMessage, setStatusMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const actionControllersRef = useRef(new Set<AbortController>());
  const deleteControllersRef = useRef(new Map<string, AbortController>());
  const submitControllerRef = useRef<AbortController | null>(null);
  const requestGateRef = useRef(new PaginatedRequestGate());
  const readInFlightRef = useRef(false);
  const loadedCountRef = useRef(0);
  const draftRevisionRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pendingDeleteFocusRef = useRef<{ id: string; index: number } | null>(null);

  useLayoutEffect(() => {
    loadedCountRef.current = collection.loaded.length;
    const pending = pendingDeleteFocusRef.current;
    if (!pending || getCommentCollectionItems(collection).some((comment) => comment.id === pending.id)) return;
    pendingDeleteFocusRef.current = null;
    const panel = panelRef.current;
    if (document.activeElement !== document.body || !panel?.getClientRects().length) return;
    const buttons = panel.querySelectorAll<HTMLButtonElement>('[data-comment-delete]:not(:disabled)');
    const target = buttons[Math.min(pending.index, buttons.length - 1)] ?? panel.querySelector('textarea');
    target?.focus({ preventScroll: true });
  }, [collection]);

  useEffect(() => {
    const controllers = actionControllersRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    const gate = requestGateRef.current;
    const request = gate.begin('replace')!;
    readInFlightRef.current = true;
    setIsLoadingMore(false);
    setIsLoading(true);
    setErrorMessage('');
    setLoadErrorMode('replace');
    void loadCommentWindow(
      (offset) => getPublicComments(bookId, targetType, targetIndex, { offset, signal: request.signal }),
      loadedCountRef.current,
      request.signal,
    )
      .then((page) => { if (gate.isCurrent(request.id)) setCollection((current) => applyCommentPage(current, page)); })
      .catch((error: unknown) => {
        if (gate.isCurrent(request.id) && !isAbortError(error)) setErrorMessage(error instanceof Error ? error.message : '评论加载失败');
      })
      .finally(() => {
        if (gate.isCurrent(request.id)) {
          readInFlightRef.current = false;
          setIsLoading(false);
          gate.complete(request.id, 'replace');
        }
      });
    return () => {
      gate.abort();
      readInFlightRef.current = false;
    };
  }, [bookId, isVisible, reloadKey, targetIndex, targetType]);

  function refreshList() {
    requestGateRef.current.abort();
    readInFlightRef.current = false;
    setIsLoadingMore(false);
    setReloadKey((key) => key + 1);
  }

  async function loadMore() {
    if (isLoading || isLoadingMore || comments.length >= commentTotal) return;
    const gate = requestGateRef.current;
    const request = gate.begin('append');
    if (!request) return;
    readInFlightRef.current = true;
    setIsLoadingMore(true);
    setErrorMessage('');
    setLoadErrorMode('append');
    try {
      const page = await getPublicComments(bookId, targetType, targetIndex, { offset: collection.loaded.length, signal: request.signal });
      if (!gate.isCurrent(request.id)) return;
      if (hasCommentPageDrift(collection, page)) {
        refreshList();
        return;
      }
      setCollection((current) => applyCommentPage(current, page, true));
    } catch (error) {
      if (gate.isCurrent(request.id) && !isAbortError(error)) setErrorMessage(error instanceof Error ? error.message : '更多评论加载失败');
    } finally {
      if (gate.isCurrent(request.id)) {
        readInFlightRef.current = false;
        setIsLoadingMore(false);
        gate.complete(request.id, 'append');
      }
    }
  }

  async function handleSubmit() {
    const body = draft.trim();
    if (!body || submitControllerRef.current) return;
    const revision = draftRevisionRef.current;
    const controller = new AbortController();
    submitControllerRef.current = controller;
    actionControllersRef.current.add(controller);
    setIsSubmitting(true);
    setSubmitError('');
    setStatusMessage('');
    try {
      const comment = await createPublicComment(bookId, { body, targetIndex, targetType }, controller.signal);
      if (controller.signal.aborted) return;
      setCollection((current) => addCreatedComment(current, comment));
      if (revision === draftRevisionRef.current) setDraft('');
      if (readInFlightRef.current) refreshList();
      setStatusMessage('评论已发送');
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) setSubmitError(error instanceof Error ? error.message : '评论发送失败');
    } finally {
      actionControllersRef.current.delete(controller);
      if (!controller.signal.aborted) {
        submitControllerRef.current = null;
        setIsSubmitting(false);
      }
    }
  }

  async function handleDelete(commentId: string) {
    if (deleteControllersRef.current.has(commentId)) return;
    const controller = new AbortController();
    deleteControllersRef.current.set(commentId, controller);
    actionControllersRef.current.add(controller);
    setDeletingIds(new Set(deleteControllersRef.current.keys()));
    setDeleteErrors((current) => ({ ...current, [commentId]: '' }));
    setStatusMessage('');
    const button = panelRef.current?.querySelector<HTMLButtonElement>(`[data-comment-delete="${CSS.escape(commentId)}"]`);
    const restoreFocus = document.activeElement === button;
    try {
      await deletePublicComment(bookId, commentId, controller.signal);
      if (controller.signal.aborted) return;
      if (restoreFocus) pendingDeleteFocusRef.current = {
        id: commentId,
        index: Math.max(0, Array.from(panelRef.current?.querySelectorAll('[data-comment-delete]') ?? []).indexOf(button!)),
      };
      setCollection((current) => removeDeletedComment(current, commentId));
      if (readInFlightRef.current) refreshList();
      setStatusMessage('评论已删除');
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) setDeleteErrors((current) => ({ ...current, [commentId]: error instanceof Error ? error.message : '评论删除失败' }));
    } finally {
      actionControllersRef.current.delete(controller);
      deleteControllersRef.current.delete(commentId);
      if (!controller.signal.aborted) setDeletingIds(new Set(deleteControllersRef.current.keys()));
    }
  }

  return (
    <div ref={panelRef} className="public-comments-panel mt-5 rounded-2xl border border-stone-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircle className="h-4 w-4 text-accent" />
          <h3 className="truncate text-sm font-semibold text-stone-900 dark:text-night-ink" title={targetLabel ?? '评论'}>{targetLabel ?? '评论'}</h3>
          {isVisible && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500 dark:bg-white/10 dark:text-night-soft">{commentTotal}</span>}
        </div>
        <Button aria-expanded={isVisible} className="min-h-11 px-3 text-xs" onClick={() => onVisibilityChange(!isVisible)} variant="secondary">
          {isVisible ? '隐藏评论' : '显示评论'}
        </Button>
      </div>

      {isVisible && (
        <div className="mt-4 space-y-4">
          <p className="sr-only" role="status">{statusMessage}</p>
          <div className="flex gap-3">
            <UserAvatar avatar={session?.avatar} name={session?.nickname ?? '读者'} role={session?.role ?? 'user'} size="sm" userId={session?.id ?? 'me'} />
            <div className="min-w-0 flex-1">
              <textarea
                aria-label={targetLabel ? `为${targetLabel}写读后感` : '写读后感'}
                className="min-h-20 w-full resize-y rounded-2xl border border-stone-200 bg-white px-3 py-2 text-base sm:text-sm [@media(any-pointer:coarse)]:text-base text-stone-900 outline-none transition focus:border-accent dark:border-white/10 dark:bg-white/[0.04] dark:text-night-ink"
                maxLength={2000}
                onChange={(event) => { draftRevisionRef.current += 1; setDraft(event.target.value); setSubmitError(''); }}
                placeholder="写一点读后感..."
                value={draft}
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-stone-400">{draft.length}/2000</span>
                <Button className="min-h-11 px-3 text-xs" disabled={!draft.trim() || isSubmitting} icon={<Send className="h-3.5 w-3.5" />} onClick={handleSubmit}>
                  {isSubmitting ? '发送中' : '发送'}
                </Button>
              </div>
            </div>
          </div>

          {submitError && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{submitError}</p>}
          {errorMessage && loadErrorMode === 'replace' && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">{errorMessage} <button className="min-h-11 px-2 font-medium underline underline-offset-4" disabled={isLoading || isLoadingMore} onClick={refreshList} type="button">重试加载评论</button></p>}

          {isLoading && comments.length === 0 ? (
            <p className="text-sm text-stone-500 dark:text-stone-400">正在加载评论...</p>
          ) : comments.length === 0 && !errorMessage ? (
            <p className="text-sm text-stone-500 dark:text-stone-400">还没有评论。</p>
          ) : (
            <div aria-busy={isLoading || isLoadingMore} aria-label="评论列表" className="space-y-3" role="list">
              {comments.map((comment) => {
                const canDelete = comment.userId === session?.id || session?.role === 'admin';
                return (
                  <div className="flex gap-3 rounded-2xl bg-stone-50 p-3 dark:bg-white/[0.04]" key={comment.id} role="listitem">
                    <UserAvatar name={comment.userNickname} role="user" size="sm" userId={comment.userId} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-stone-900 dark:text-night-ink" title={comment.userNickname}>{comment.userNickname}</p>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-stone-400">{formatDate(comment.createdAt)}</span>
                          {canDelete && (
                            <button aria-label={`删除${comment.userNickname}的评论`} data-comment-delete={comment.id} disabled={deletingIds.has(comment.id)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50 dark:hover:bg-red-950/30" onClick={() => void handleDelete(comment.id)} title="删除评论" type="button">
                              {deletingIds.has(comment.id) ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-stone-600 dark:text-night-soft">{comment.body}</p>
                      {deleteErrors[comment.id] && <p role="alert" className="mt-2 break-words text-xs text-red-600 dark:text-red-300">{deleteErrors[comment.id]}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {errorMessage && loadErrorMode === 'append' && <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="alert" className="break-words text-sm text-red-600 dark:text-red-300">{errorMessage}</p>
            <Button className="min-h-11 px-3 text-xs" disabled={isLoadingMore} onClick={() => void loadMore()} variant="secondary">重试加载更多评论</Button>
          </div>}
          {!isLoading && !errorMessage && comments.length < commentTotal && (
            <Button className="min-h-11 w-full px-3 text-xs" disabled={isLoadingMore} onClick={() => void loadMore()} variant="secondary">
              {isLoadingMore ? '加载中...' : `加载更多评论（还剩 ${commentTotal - comments.length} 条）`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
