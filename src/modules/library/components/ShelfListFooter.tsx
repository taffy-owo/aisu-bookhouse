import { useLayoutEffect, useRef, type MouseEvent, type Ref } from 'react';
import { Button } from '../../../shared/components/Button';

const SHELF_RESULT_SELECTOR = '[data-book-id], button[aria-expanded][aria-controls]';

interface ShelfListFooterProps {
  hasMore: boolean;
  isLoadingMore: boolean;
  isRefreshing: boolean;
  refreshError: string;
  pageError: string;
  heldMessage?: string;
  sentinelRef: Ref<HTMLDivElement>;
  onLoadMore: () => void;
  onRetryRefresh: () => void;
}

export function ShelfListFooter({ hasMore, isLoadingMore, isRefreshing, refreshError, pageError, heldMessage, sentinelRef, onLoadMore, onRetryRefresh }: ShelfListFooterProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const keyboardRequestRef = useRef<'requested' | 'loading' | null>(null);
  const requestLocationRef = useRef('');
  const appendSnapshotRef = useRef<{ page: string | undefined; nodes: Set<Element> } | null>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    // Keep the tallest feedback state until this collection is replaced. A
    // wrapped error must not pull the last book down when retry starts.
    if (content) content.style.minHeight = `${content.getBoundingClientRect().height}px`;
    if (!keyboardRequestRef.current) return;
    const collection = content?.closest<HTMLElement>('[data-navigation-pages]');
    const previous = appendSnapshotRef.current;
    const didAppend = Boolean(previous && collection && collection.dataset.navigationPages !== previous.page);
    if (isRefreshing || isLoadingMore) keyboardRequestRef.current = 'loading';
    else if (keyboardRequestRef.current === 'loading' || didAppend) {
      keyboardRequestRef.current = null;
      if (content && document.activeElement === content && requestLocationRef.current === window.location.href) {
        const added = didAppend && previous
          ? [...collection?.querySelectorAll<HTMLElement>(SHELF_RESULT_SELECTOR) ?? []].find((node) => !previous.nodes.has(node)) : undefined;
        const nextBook = added?.matches('button') ? added : [...added?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled])') ?? []].find((node) => !node.closest('[inert]'));
        // Continue with the newly loaded books, rather than leaving keyboard
        // focus on a footer that has moved below the visible results.
        if (nextBook) nextBook.focus();
        else (content.querySelector<HTMLButtonElement>('button') ?? content).focus({ preventScroll: true });
      }
      appendSnapshotRef.current = null;
    }
  });

  useLayoutEffect(() => {
    const content = contentRef.current;
    const collection = content?.closest<HTMLElement>('[data-navigation-pages]');
    return () => {
      // A successful refresh can remove the final book and the footer itself.
      // Transfer an owned keyboard focus to its replacement empty state only.
      if (!content || !collection || !keyboardRequestRef.current || document.activeElement !== content) return;
      queueMicrotask(() => {
        if (!collection.isConnected || document.activeElement !== document.body || requestLocationRef.current !== window.location.href) return;
        const empty = collection.querySelector<HTMLElement>('[data-empty-state]');
        (empty?.querySelector<HTMLElement>('button, a[href]') ?? empty)?.focus({ preventScroll: true });
      });
    };
  }, []);

  const handleAction = (event: MouseEvent<HTMLButtonElement>, action: () => void, appends: boolean) => {
    keyboardRequestRef.current = null;
    appendSnapshotRef.current = null;
    if (event.currentTarget.matches(':focus-visible')) {
      keyboardRequestRef.current = 'requested';
      requestLocationRef.current = window.location.href;
      const collection = contentRef.current?.closest<HTMLElement>('[data-navigation-pages]');
      appendSnapshotRef.current = appends && collection ? {
        page: collection.dataset.navigationPages,
        nodes: new Set(collection.querySelectorAll(SHELF_RESULT_SELECTOR)),
      } : null;
      // Keep focus on a persistent node before the loading render removes its
      // action. Completion must not reclaim focus after the person tabs away.
      contentRef.current?.focus({ preventScroll: true });
    }
    action();
  };

  const error = refreshError || pageError;
  return (
    <div className="mt-4" data-shelf-footer ref={sentinelRef}>
      <div aria-label="图书列表状态" className="flex min-h-12 flex-wrap items-center justify-center gap-3 text-center text-sm text-stone-500 dark:text-stone-400" ref={contentRef} role="group" tabIndex={-1}>
        {isRefreshing ? <p role="status">正在更新图书…</p>
          : heldMessage ? <p role="status">{heldMessage}</p>
            : error ? <>
              <p className="min-w-0 break-words" role="alert">{refreshError ? `更新失败，已保留当前列表。${error}` : error}</p>
              <Button onClick={(event) => handleAction(event, refreshError ? onRetryRefresh : onLoadMore, !refreshError)} variant="secondary">{refreshError ? '重试更新' : '重试加载'}</Button>
            </>
              : isLoadingMore ? <p role="status">正在加载更多…</p>
                : hasMore ? <Button onClick={(event) => handleAction(event, onLoadMore, true)} variant="secondary">加载更多</Button>
                  : <p className="text-xs">已显示全部图书</p>}
      </div>
    </div>
  );
}
