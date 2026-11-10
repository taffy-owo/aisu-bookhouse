import type { ReactNode } from 'react';
import { cn } from '../../../shared/utils/cn';
import type { ReaderTheme } from '../types/reader';

export function ReaderStateSurface({ children, theme }: { children: ReactNode; theme: ReaderTheme }) {
  return (
    <main className={cn('reader-state-surface fixed inset-0 z-40 flex flex-col overflow-y-auto px-5 py-10 text-sm', `reader-theme-${theme}`)}>
      <div className="m-auto w-full min-w-0 max-w-lg shrink-0">{children}</div>
    </main>
  );
}
