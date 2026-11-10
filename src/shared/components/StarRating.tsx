import { Star } from 'lucide-react';
import { cn } from '../utils/cn';

interface StarRatingProps {
  /** Rating on a 0-10 scale (five stars, each worth 2 points, half-star = 1 point). */
  value: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
  readOnly?: boolean;
  size?: 'sm' | 'md';
  showValue?: boolean;
  className?: string;
}

const STAR_COUNT = 5;

export function StarRating({ value, onChange, disabled = false, readOnly = false, size = 'md', showValue = true, className }: StarRatingProps) {
  const interactive = !readOnly && Boolean(onChange);
  const displayValue = Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : 0;
  const starSize = size === 'sm' ? 'h-4 w-4' : 'h-6 w-6';
  const valueLabel = displayValue > 0 ? `${displayValue.toFixed(1)} / 10` : '未评分';

  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      <div className={cn('relative rounded-md', interactive && 'h-11 w-[180px] max-w-full focus-within:ring-2 focus-within:ring-accent/60 focus-within:ring-offset-2 dark:focus-within:ring-offset-night')}>
        <div aria-hidden="true" className={cn('flex items-center', interactive ? 'h-full justify-between px-1' : 'gap-0.5')}>
          {Array.from({ length: STAR_COUNT }, (_, index) => (
            <span className="relative inline-flex" key={index}>
              <Star className={cn(starSize, 'text-stone-300 dark:text-stone-600')} />
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${Math.min(1, Math.max(0, displayValue / 2 - index)) * 100}%` }}>
                <Star className={cn(starSize, 'fill-current text-accent')} />
              </span>
            </span>
          ))}
        </div>
        {interactive && <input
          aria-label="评分"
          aria-valuetext={valueLabel}
          className="absolute inset-0 h-11 w-full cursor-pointer opacity-0 disabled:cursor-default"
          disabled={disabled}
          max={10}
          min={0}
          onChange={(event) => onChange?.(Number(event.target.value))}
          step={1}
          type="range"
          value={displayValue}
        />}
      </div>
      {showValue && <span className="text-sm tabular-nums text-stone-500 dark:text-stone-400">{valueLabel}</span>}
      {interactive && displayValue > 0 && <button
        aria-label="清除评分"
        className="min-h-11 min-w-11 px-1 text-xs text-stone-400 underline-offset-2 hover:text-accent hover:underline disabled:cursor-default disabled:opacity-50"
        disabled={disabled}
        onClick={() => onChange?.(0)}
        type="button"
      >清除</button>}
    </div>
  );
}
