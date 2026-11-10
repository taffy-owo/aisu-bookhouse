import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '../../../shared/utils/cn';
import { formatReadingDuration, type PendingReadingActivitySummary } from '../services/readingActivity';

export function ReadingActivityPendingNotice({ className, isLoading, loadFailed = false, onRetry, pending }: {
  className?: string;
  isLoading: boolean;
  loadFailed?: boolean;
  onRetry: () => void;
  pending: PendingReadingActivitySummary;
}) {
  return (
    <div className={cn('flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs leading-5 text-stone-500 dark:text-stone-400', className)}>
      <p className="min-w-0 flex-1" role="status">{isLoading ? '正在同步阅读记录…' : <>有 <span className="whitespace-nowrap">{formatReadingDuration(pending.seconds)}</span>阅读记录<span className="whitespace-nowrap">待确认同步。</span></>}{!isLoading && loadFailed && <span className="block">云端统计暂时<span className="whitespace-nowrap">无法读取。</span></span>}</p>
      <button aria-label="重试同步阅读时长" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-1 font-medium text-accent hover:underline disabled:opacity-60 dark:text-accent-soft" disabled={isLoading} onClick={onRetry} type="button">
        {isLoading ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw aria-hidden className="h-3.5 w-3.5" />}{isLoading ? '同步中' : '重试同步'}
      </button>
    </div>
  );
}
