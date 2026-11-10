import { cn } from '../../../shared/utils/cn';
import { HAIRLINE } from '../../../shared/ui';

const placeholder = 'bg-stone-900/5 dark:bg-white/[0.05]';

export function BookShelfSkeleton({ count = 12, view = 'grid' }: { count?: number; view?: 'grid' | 'list' }) {
  return (
    <div
      aria-busy="true"
      className={cn('motion-safe:animate-pulse', view === 'grid' && 'book-grid grid grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 sm:grid-cols-4 sm:gap-x-4 sm:gap-y-8 md:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7')}
      role="status"
    >
      <span className="sr-only">正在加载图书…</span>
      {Array.from({ length: count }, (_, index) => view === 'grid' ? (
        <div aria-hidden="true" className="min-w-0" key={index}>
          <div className={cn('aspect-[0.68] rounded-xl', placeholder)} />
          <div className="mt-2.5 h-[2.8em] space-y-1.5 text-[13px] sm:text-sm">
            <div className={cn('h-3.5 rounded', placeholder)} />
            <div className={cn('h-3.5 w-2/3 rounded', placeholder)} />
          </div>
          <div className={cn('mt-0.5 h-4 w-2/3 rounded', placeholder)} />
          <div className={cn('mt-1.5 h-3 w-1/2 rounded', placeholder)} />
        </div>
      ) : (
        <div aria-hidden="true" className={cn('book-list-item flex flex-col gap-3 border-b py-4', HAIRLINE)} key={index}>
          <div className="book-list-main flex gap-4">
            <div className="book-list-cover shrink-0"><div className={cn('h-24 w-16 rounded-lg', placeholder)} /></div>
            <div className="book-list-content min-w-0 flex-1 py-0.5">
              <div className={cn('h-5 w-3/4 rounded', placeholder)} />
              <div className={cn('mt-1 h-4 w-1/3 rounded', placeholder)} />
              <div className={cn('mt-2 h-4 w-16 rounded', placeholder)} />
              <div className="book-list-actions mt-3 flex gap-2">
                <div className={cn('h-11 w-16 rounded-xl', placeholder)} />
                <div className={cn('h-11 w-16 rounded-xl', placeholder)} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
