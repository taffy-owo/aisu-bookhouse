import { AlertCircle, ChevronDown, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { TranslationSubmission } from '../services/translationSubmissionStorage';
import { TaskErrorMessage } from './TaskErrorMessage';

interface Props {
  submissions: TranslationSubmission[];
  storageWarning: string;
  disabled: boolean;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

export function TranslationSubmissionList({ submissions, storageWarning, disabled, onRetry, onRemove }: Props) {
  const pendingCount = submissions.filter((item) => item.status === 'pending').length;
  const unconfirmedCount = submissions.length - pendingCount;
  if (!submissions.length && !storageWarning) return null;
  return (
    <section aria-label="翻译提交记录" className="mb-2">
      {storageWarning && <p role="alert" className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">{storageWarning}</p>}
      {submissions.length > 0 && <details className="group/submissions">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300" data-task-focus-control="submissions">
          {pendingCount > 0 ? <LoaderCircle aria-hidden className="h-4 w-4 shrink-0 animate-spin" /> : <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />}
          <span className="flex-1">{pendingCount > 0 && `${pendingCount} 条正在提交`}{unconfirmedCount > 0 && `${pendingCount ? ' · ' : ''}${unconfirmedCount} 条提交尚未确认`}</span>
          <ChevronDown aria-hidden className="h-4 w-4 shrink-0 transition-transform group-open/submissions:rotate-180" />
        </summary>
      <div className="mt-1 divide-y divide-ink/[0.08] dark:divide-white/[0.07]">
        {submissions.map((item) => (
          <div aria-label={`翻译提交：${item.sourceUrl}`} aria-busy={item.status === 'pending'} className="py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:focus-visible:outline-peach" data-task-focus-id={`submission:${item.id}`} data-translation-submission={item.id} key={item.id} role="group" tabIndex={-1}>
            <p className="truncate text-sm text-stone-800 dark:text-night-ink" title={item.sourceUrl}>{item.sourceUrl}</p>
            <div className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
              {item.status === 'pending'
                ? <p className="flex items-start gap-1.5" role="status"><LoaderCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />正在加入翻译任务…</p>
                : <TaskErrorMessage message={`未确认加入 · ${item.error}`} role="status" summary="未确认加入，请先核对下方翻译任务。" />}
            </div>
            <div className="mt-1 flex flex-wrap items-start gap-x-4 gap-y-1 text-xs">
            <details className="text-stone-500 dark:text-stone-400">
              <summary data-task-focus-control="settings" className="min-h-11 w-fit cursor-pointer py-3 focus-visible:outline-accent">查看原设置</summary>
              <p className="mb-1 break-all leading-relaxed">{item.sourceUrl}</p>
              <p className="break-words leading-relaxed [overflow-wrap:anywhere]">{item.modelLabel} · {item.model} · {item.requestConcurrency} 路并发</p>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{item.customInstructions || '未填写额外翻译要求'}</p>
              <p className="mt-2 leading-relaxed">若下方已出现对应任务，可移除此处的提交记录，翻译会继续运行。</p>
            </details>
            {item.status !== 'pending' && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <button data-task-focus-control="retry" data-task-focus-primary className="inline-flex min-h-11 items-center gap-1 text-accent focus-visible:outline-accent disabled:opacity-50 dark:text-peach" disabled={disabled} onClick={() => onRetry(item.id)} type="button"><RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />按原设置重试</button>
                <button data-task-focus-control="remove" className="inline-flex min-h-11 items-center gap-1 text-stone-500 focus-visible:outline-accent disabled:opacity-50 dark:text-stone-400" disabled={disabled} onClick={() => onRemove(item.id)} type="button"><X aria-hidden="true" className="h-3.5 w-3.5" />移除本地记录</button>
              </div>
            )}
            </div>
          </div>
        ))}
      </div>
      </details>}
    </section>
  );
}
