import { cn } from '../utils/cn';
import { formatReadingProgressPercent, normalizeReadingProgress } from '../utils/readingProgress';

interface ProgressBarProps {
  className?: string;
  label?: string;
  showLabel?: boolean;
  value: number;
}

export function ProgressBar({ className, label = '阅读进度', showLabel = true, value }: ProgressBarProps) {
  const normalizedValue = normalizeReadingProgress(value);
  const labelValue = formatReadingProgressPercent(normalizedValue);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={normalizedValue}
        aria-valuetext={labelValue}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-200/80 dark:bg-white/10"
        role="progressbar"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out dark:bg-peach" style={{ width: `${normalizedValue}%` }} />
      </div>
      {showLabel && <span className="w-8 text-right text-[11px] tabular-nums text-stone-400">{labelValue}</span>}
    </div>
  );
}
