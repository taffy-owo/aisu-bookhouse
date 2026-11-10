import { AlertCircle, ChevronDown, Cloud, ExternalLink, FileUp, RotateCcw, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getBookDetailPath } from '../../../config/routes';
import { ProgressBar } from '../../../shared/components/ProgressBar';
import { cn } from '../../../shared/utils/cn';
import { formatFileSize } from '../../../shared/utils/formatFileSize';
import { getUploadStatusMeta } from '../services/uploadService';
import type { UploadTask } from '../types/upload';

interface UploadTaskItemProps {
  canRetryFromMemory?: boolean;
  task: UploadTask;
  onCancel?: (task: UploadTask) => void;
  onRetry?: (task: UploadTask) => void;
}

const toneClass = {
  accent: 'bg-sakura text-accent dark:bg-plum/50',
  danger: 'bg-red-50 text-red-600 dark:bg-red-950/20 dark:text-red-400',
  success: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20 dark:text-emerald-400',
};

export function UploadTaskItem({ canRetryFromMemory = false, task, onCancel, onRetry }: UploadTaskItemProps) {
  const meta = getUploadStatusMeta(task.status);
  const Icon = task.status === 'ready' ? Sparkles : task.status === 'failed' ? AlertCircle : Cloud;
  const showCancel = Boolean(onCancel) && (task.status === 'uploading' || task.status === 'queued');
  const showRetry = Boolean(onRetry) && task.status === 'failed';
  const requiresReselect = showRetry && !task.bookId && (task.fileSize <= 0 || !canRetryFromMemory);
  const retryLabel = task.bookId ? '重新解析' : requiresReselect ? '重新选择' : '重试';
  const isFinished = task.status === 'ready' || task.status === 'failed';
  const failureMessage = task.message?.trim() || meta.description;

  if (isFinished) {
    return (
      <div aria-label={`${task.fileName}上传任务`} className="upload-task-item group rounded-2xl border border-stone-200/80 bg-white/70 px-3 py-3 transition hover:border-stone-300 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:border-white/[0.08] dark:bg-white/[0.025] dark:hover:border-white/[0.14] dark:hover:bg-white/[0.045]" data-task-focus-id={`upload:${task.id}`} role="group" tabIndex={-1}>
        <div className="flex items-center gap-2.5">
          <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', toneClass[meta.tone])}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={task.fileName}>{task.fileName}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400">
              <span>{task.fileType}</span>
              <span aria-hidden="true">·</span>
              <span>{formatFileSize(task.fileSize)}</span>
              <span aria-hidden="true">·</span>
              <span className={task.status === 'failed' ? 'text-red-500 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>{meta.label}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {task.bookId && (
              <Link
                data-task-focus-control="open"
                data-task-focus-primary
                aria-label={`查看${task.fileName}详情`}
              className="grid h-10 w-10 place-items-center rounded-xl text-stone-400 transition hover:bg-sakura hover:text-accent dark:text-stone-500 dark:hover:bg-plum/35 dark:hover:text-accent-soft"
                title="查看详情"
                to={getBookDetailPath(task.bookId)}
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            )}
            {showRetry && (
              <button
                data-task-focus-control="retry"
                data-task-focus-primary
                aria-label={`${retryLabel}${task.fileName}`}
                className={cn(
                  'h-10 rounded-xl text-stone-400 transition hover:bg-sakura hover:text-accent dark:text-stone-500 dark:hover:bg-plum/35 dark:hover:text-accent-soft',
                  requiresReselect ? 'inline-flex items-center gap-1.5 px-2.5 text-xs font-medium' : 'grid w-10 place-items-center',
                )}
                onClick={() => onRetry?.(task)}
                title={requiresReselect ? '重新选择文件' : retryLabel}
                type="button"
              >
                {requiresReselect ? <FileUp className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                {requiresReselect && <span>重新选择</span>}
              </button>
            )}
          </div>
        </div>
        {task.status === 'failed' && (
          <details className="group/task-error mt-1 text-red-500/90 dark:text-red-300/90">
            <summary
              aria-label={`《${task.fileName}》失败详情`}
              className="flex min-h-6 cursor-pointer list-none items-center gap-1.5 rounded-sm text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
              title={failureMessage}
            >
              <span className="min-w-0 flex-1 truncate group-open/task-error:hidden">{failureMessage}</span>
              <span className="hidden flex-1 group-open/task-error:inline">失败详情</span>
              <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-open/task-error:rotate-180" />
            </summary>
            <div className="mt-1 space-y-1 whitespace-pre-wrap text-xs leading-5 [overflow-wrap:anywhere]">
              <p className="text-stone-600 dark:text-night-soft">{task.fileName}</p>
              <p>{failureMessage}</p>
            </div>
          </details>
        )}
      </div>
    );
  }

  return (
    <div aria-busy={true} aria-label={`${task.fileName}上传任务`} className="upload-task-item rounded-2xl border border-stone-200 bg-white p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:border-white/10 dark:bg-white/[0.03]" data-task-focus-id={`upload:${task.id}`} role="group" tabIndex={-1}>
      <div className="flex items-center gap-3">
        <div className={cn('grid h-10 w-10 place-items-center rounded-2xl', toneClass[meta.tone])}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={task.fileName}>{task.fileName}</div>
          <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {task.fileType} · {formatFileSize(task.fileSize)} · {meta.label}
          </div>
        </div>
        {showCancel && (
          <button
            data-task-focus-control="cancel"
            data-task-focus-primary
            className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full border border-stone-200 px-3 py-1 text-xs font-medium text-stone-500 transition hover:border-red-300 hover:text-red-500 dark:border-white/10 dark:text-stone-400 dark:hover:border-red-500/40 dark:hover:text-red-400"
            onClick={() => onCancel?.(task)}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
            取消
          </button>
        )}
      </div>
      <ProgressBar className="mt-4" label={`${task.fileName}导入进度`} value={task.progress} />
      <p className="mt-3 text-xs leading-5 text-stone-500 dark:text-stone-400">{task.message ?? meta.description}</p>
      {task.bookId && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-accent transition hover:bg-sakura dark:hover:bg-plum/35" to={getBookDetailPath(task.bookId)}>
            查看详情
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}
