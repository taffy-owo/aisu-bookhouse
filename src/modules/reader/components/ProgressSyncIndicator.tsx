import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getAccountScope } from '../../../shared/api';
import { flushReadingProgressSync, getReadingProgressSyncStatus, subscribeReadingProgressSync } from '../services/readingProgressSync';

export function ProgressSyncIndicator({ bookId, inline = false, actionable = false, inverted = false }: { bookId: string; inline?: boolean; actionable?: boolean; inverted?: boolean }) {
  const getStatus = useCallback(() => getReadingProgressSyncStatus(bookId), [bookId]);
  const status = useSyncExternalStore(subscribeReadingProgressSync, getStatus, () => 'synced');
  const scope = getAccountScope();
  const retryKey = JSON.stringify([scope, bookId]);
  const latestKeyRef = useRef(retryKey);
  useLayoutEffect(() => { latestKeyRef.current = retryKey; }, [retryKey]);
  const mountedRef = useRef(true);
  const retriesRef = useRef(new Set<string>());
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const retry = () => {
    if (retriesRef.current.has(retryKey)) return;
    retriesRef.current.add(retryKey);
    setRetryingKey(retryKey);
    void flushReadingProgressSync(bookId).catch(() => {
      // The durable queue retains this position and its failure status.
    }).finally(() => {
      retriesRef.current.delete(retryKey);
      if (mountedRef.current && latestKeyRef.current === retryKey) setRetryingKey(null);
    });
  };
  const title = '阅读位置尚未保存。请检查网络、登录状态或正文是否已更新；正文有更新时，请先加载新版再继续阅读。';

  // Normal syncing is intentionally silent. The queue is an implementation
  // detail and should not cover the reading surface; only a non-retryable
  // failure needs a visible reminder.
  if (status !== 'needs-attention') {
    return null;
  }

  if (actionable) {
    const isRetrying = retryingKey === retryKey;
    return <button
      aria-busy={isRetrying}
      aria-label="重试保存阅读位置"
      className={`reader-sync-inline mr-auto min-h-11 min-w-0 truncate pr-3 text-left text-[11px] underline-offset-4 hover:underline disabled:opacity-60 ${inverted ? 'text-[#d6bdad]' : 'text-[color:var(--reader-accent)]'}`}
      disabled={isRetrying}
      onClick={(event) => { event.stopPropagation(); retry(); }}
      title={title}
      type="button"
    >{isRetrying ? '正在保存…' : '位置未保存 · 重试'}</button>;
  }

  return (
    <span
      aria-live="polite"
      className={inline
        ? 'reader-sync-inline mr-auto min-w-0 truncate pr-3 text-[11px] text-[color:var(--reader-accent)]'
        : 'pointer-events-none fixed bottom-20 right-3 z-[55] rounded-full bg-amber-100 px-2.5 py-1 text-[11px] text-amber-950 shadow-sm'}
      title={title}
    >
      同步需要处理
    </span>
  );
}
