import { Loader2, RefreshCw } from 'lucide-react';

interface ProfileResourceFeedbackProps {
  error: string;
  isLoading: boolean;
  label: string;
  onRetry: () => void;
  hasData?: boolean;
  fallbackMessage?: string;
}

export function ProfileResourceFeedback({ error, isLoading, label, onRetry, hasData = false, fallbackMessage }: ProfileResourceFeedbackProps) {
  if (isLoading) return <p className="mt-4 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400" role="status"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />正在读取{label}…</p>;
  if (!error) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <div className="min-w-0 flex-1" role="alert">
        <p className="text-red-600 dark:text-red-300">{label}暂时无法读取</p>
        <p className="mt-1 break-words text-xs leading-5 text-stone-500 dark:text-stone-400">{fallbackMessage || (hasData ? '已保留上次读取的内容。' : error)}</p>
      </div>
      <button aria-label={`重试${label}`} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-accent transition hover:bg-accent/5 dark:text-accent-soft dark:hover:bg-white/5" onClick={onRetry} type="button"><RefreshCw aria-hidden className="h-3.5 w-3.5" />重试</button>
    </div>
  );
}
