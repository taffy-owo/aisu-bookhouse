import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { UploadTaskItem } from './UploadTaskItem';
import type { UploadTask } from '../types/upload';

const COLLAPSED_HISTORY_COUNT = 4;

interface UploadTaskListProps {
  canCancelTask?: (task: UploadTask) => boolean;
  canRetryTask?: (task: UploadTask) => boolean;
  tasks: UploadTask[];
  onCancel?: (task: UploadTask) => void;
  onRetry?: (task: UploadTask) => void;
}

export function UploadTaskList({ canCancelTask, canRetryTask, tasks, onCancel, onRetry }: UploadTaskListProps) {
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const currentTasks = useMemo(() => tasks.filter((task) => task.status !== 'ready'), [tasks]);
  const historyTasks = useMemo(() => tasks.filter((task) => task.status === 'ready'), [tasks]);
  const visibleHistoryTasks = isHistoryExpanded ? historyTasks : historyTasks.slice(0, COLLAPSED_HISTORY_COUNT);

  useEffect(() => {
    if (historyTasks.length <= COLLAPSED_HISTORY_COUNT) {
      setIsHistoryExpanded(false);
    }
  }, [historyTasks.length]);

  if (tasks.length === 0) {
    return <div className="rounded-3xl border border-dashed border-stone-200 px-5 py-8 text-center text-sm text-stone-500 dark:border-white/10 dark:text-stone-400">暂无上传任务</div>;
  }

  return (
    <div className="space-y-5">
      {currentTasks.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between px-1 text-xs text-stone-500 dark:text-stone-400">
            <span>当前上传</span>
            <span>{currentTasks.length} 项</span>
          </div>
          <div className="space-y-2.5">
            {currentTasks.map((task) => (
              <UploadTaskItem canRetryFromMemory={canRetryTask?.(task)} key={task.id} onCancel={canCancelTask?.(task) === false ? undefined : onCancel} onRetry={onRetry} task={task} />
            ))}
          </div>
        </section>
      )}

      {historyTasks.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between px-1 text-xs text-stone-500 dark:text-stone-400">
            <span>已完成</span>
            <span>{historyTasks.length} 项</span>
          </div>
          <div className="space-y-2">
            {visibleHistoryTasks.map((task) => (
              <UploadTaskItem canRetryFromMemory={canRetryTask?.(task)} key={task.id} onCancel={canCancelTask?.(task) === false ? undefined : onCancel} onRetry={onRetry} task={task} />
            ))}
          </div>
          {historyTasks.length > COLLAPSED_HISTORY_COUNT && (
            <button
              aria-expanded={isHistoryExpanded}
              className="mt-2 flex min-h-10 w-full items-center justify-center gap-1.5 rounded-2xl text-xs font-medium text-stone-500 transition hover:bg-stone-100/70 hover:text-ink dark:text-stone-400 dark:hover:bg-white/[0.05] dark:hover:text-night-ink"
              onClick={() => setIsHistoryExpanded((expanded) => !expanded)}
              type="button"
            >
              {isHistoryExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {isHistoryExpanded ? '收起记录' : `再看 ${historyTasks.length - COLLAPSED_HISTORY_COUNT} 条`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
