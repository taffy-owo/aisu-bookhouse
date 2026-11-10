import type { ReactNode } from 'react';
import { HAIRLINE } from '../ui';
import { cn } from '../utils/cn';

interface EmptyStateProps {
  action?: ReactNode;
  /** Optional single factual line (e.g. an error message). Empty states usually need none. */
  description?: string;
  title: string;
}

export function EmptyState({ action, description, title }: EmptyStateProps) {
  return (
    <div aria-label={title} className={cn('border-y py-16 text-center sm:py-24', HAIRLINE)} data-empty-state role="group" tabIndex={-1}>
      <h3 className="font-display text-2xl font-semibold text-stone-900 sm:text-3xl dark:text-night-ink">{title}</h3>
      {description && <p className="mx-auto mt-3 max-w-md break-words text-sm leading-6 text-stone-500 dark:text-stone-400">{description}</p>}
      {action && <div className="mt-7 flex justify-center">{action}</div>}
    </div>
  );
}
