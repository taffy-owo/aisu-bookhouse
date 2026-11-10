import { LoaderCircle, RotateCcw } from 'lucide-react';

export interface TaskListReadState {
  hasLoaded: boolean;
  isLoading: boolean;
  error: string;
}

export function TaskListReadStatus({ label, state, disabled, onRetry }: {
  label: string;
  state: TaskListReadState;
  disabled: boolean;
  onRetry: () => void;
}) {
  if (state.hasLoaded && !state.error) return null;
  const hasLongDiagnostic = state.error.length > 120 || state.error.split('\n').length > 3;
  return (
    <div aria-label={`${label}读取状态`} className="mb-3 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
      {state.error ? (
        <>
          <p className="break-words [overflow-wrap:anywhere]" role="status">{label}{state.hasLoaded ? '更新失败，当前显示上次读取的记录。' : '未能读取。'}{!hasLongDiagnostic && state.error}</p>
          <button className="inline-flex min-h-11 items-center gap-1.5 text-accent focus-visible:outline-accent disabled:opacity-50 dark:text-peach" disabled={disabled || state.isLoading} onClick={onRetry} type="button">
            {state.isLoading ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />}
            {state.isLoading ? `正在重新读取${label}…` : `重新读取${label}`}
          </button>
          {hasLongDiagnostic && (
            <details>
              <summary className="min-h-11 w-fit cursor-pointer py-3 focus-visible:outline-accent">查看错误详情</summary>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{state.error}</p>
            </details>
          )}
        </>
      ) : (
        <p className="flex items-center gap-1.5" role="status"><LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />正在读取{label}…</p>
      )}
    </div>
  );
}
