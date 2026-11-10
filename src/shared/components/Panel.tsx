import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn';

interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  className?: string;
}

export function Panel({ children, className, ...props }: PanelProps) {
  return (
    <section {...props} className={cn('app-panel min-w-0 py-2 sm:py-4 lg:py-2', className)}>
      {children}
    </section>
  );
}
