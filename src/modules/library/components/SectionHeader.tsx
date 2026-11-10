import type { ReactNode } from 'react';
import { HAIRLINE } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';

interface SectionHeaderProps {
  action?: ReactNode;
  className?: string;
  /** Pale serif ordinal (e.g. "01") used as a section marker. */
  index?: string;
  title: string;
}

export function SectionHeader({ action, className, index, title }: SectionHeaderProps) {
  return (
    <div className={cn('flex items-end justify-between gap-4 border-b pb-2.5', HAIRLINE, className)}>
      <div className="flex min-w-0 items-baseline gap-3">
        {index && (
          <span
            aria-hidden
            className="-mb-1 select-none font-display text-4xl font-medium leading-none tabular-nums text-ink/[0.16] sm:text-5xl lg:text-3xl dark:text-white/[0.12]"
          >
            {index}
          </span>
        )}
        <h2 className="truncate font-display text-xl font-semibold tracking-normal text-stone-950 sm:text-2xl lg:text-lg dark:text-night-ink">
          {title}
        </h2>
      </div>
      {action && <div className="shrink-0 pb-0.5">{action}</div>}
    </div>
  );
}
