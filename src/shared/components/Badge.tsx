import type { ReactNode } from 'react';
import { cn } from '../utils/cn';

interface BadgeProps {
  children: ReactNode;
  className?: string;
}

export function Badge({ children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-sakura px-3 py-1 text-xs font-medium text-accent-strong dark:bg-accent/10 dark:text-[#d6aaa0]',
        className,
      )}
    >
      {children}
    </span>
  );
}
