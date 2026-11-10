import { ArrowLeft, ArrowRight, Layers3 } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { getBookDetailPath } from '../../../config/routes';
import { ProgressBar } from '../../../shared/components/ProgressBar';
import { cn } from '../../../shared/utils/cn';
import type { Book } from '../../books';
import { getBookProgressLabel } from '../../books/services/bookProgress';
import type { BookSeriesShelf } from '../services/bookSeries';

interface BookSeriesPanelProps {
  shelf: BookSeriesShelf;
}

export function BookSeriesPanel({ shelf }: BookSeriesPanelProps) {
  const navigationState = createCollectionLinkState(useLocation());
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 pb-3 dark:border-stone-800">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-sakura px-3 py-1 text-xs font-medium text-accent-strong dark:bg-plum/45 dark:text-accent-soft">
            <Layers3 className="h-3.5 w-3.5" />
            同系列
          </div>
          <h2 className="mt-3 font-display text-2xl lg:text-lg font-semibold text-stone-950 dark:text-night-ink">{shelf.label}</h2>
        </div>
        <div className="text-sm text-stone-500 dark:text-stone-400">
          第 {shelf.currentIndex + 1} / {shelf.books.length} 本
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SeriesNeighborLink book={shelf.previousBook} direction="previous" />
        <SeriesNeighborLink book={shelf.nextBook} direction="next" />
      </div>

      <div className="max-h-[420px] overflow-y-auto overflow-x-hidden pr-1 custom-scrollbar space-y-2">
        {shelf.books.map((book, index) => (
          <Link
            aria-current={book.id === shelf.current.id ? 'page' : undefined}
            className={cn(
              'flex min-h-14 items-center gap-3 rounded-2xl border px-3 py-2 text-sm transition',
              book.id === shelf.current.id
                ? 'border-accent/40 bg-sakura text-accent-strong dark:border-accent/30 dark:bg-plum/35 dark:text-accent-soft'
                : 'border-stone-200 bg-white/60 text-stone-700 hover:border-accent/35 hover:text-accent dark:border-white/10 dark:bg-white/[0.03] dark:text-night-copy dark:hover:text-accent-soft',
            )}
            key={book.id}
            state={navigationState} to={getBookDetailPath(book.id)}
          >
            <span className={cn(
              "w-6 shrink-0 font-mono text-xs text-center transition",
              book.id === shelf.current.id
                ? "font-semibold text-accent-strong dark:text-accent-soft"
                : "text-stone-400 dark:text-stone-500"
            )}>
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block break-words font-medium [overflow-wrap:anywhere]">
                {book.title}
              </span>
              <span className="mt-1 block text-xs text-stone-600 dark:text-night-soft">{book.seriesInfo.orderLabel || `第 ${index + 1} 卷`}</span>
            </span>
            <span className="w-16 shrink-0 text-right sm:w-24" title={getBookProgressLabel(book.progressPercent, book.lastReadAt).label}>
              <span className="mb-1 block text-[11px] tabular-nums text-stone-600 dark:text-night-soft">
                {getBookProgressLabel(book.progressPercent, book.lastReadAt).label}
              </span>
              <ProgressBar className="h-1.5" showLabel={false} value={book.progressPercent} />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function SeriesNeighborLink({ book, direction }: { book: (BookSeriesShelf['books'][number] & Book) | null; direction: 'next' | 'previous' }) {
  const navigationState = createCollectionLinkState(useLocation());
  const label = direction === 'previous' ? '上一卷' : '下一卷';
  const Icon = direction === 'previous' ? ArrowLeft : ArrowRight;

  if (!book) {
    return (
      <div className="flex min-h-20 items-center gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 text-sm text-stone-400 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-500">
        <Icon className="h-4 w-4" />
        {label}暂无
      </div>
    );
  }

  return (
    <Link
      className="flex min-h-20 items-center gap-3 rounded-2xl border border-stone-200 bg-white/70 px-4 text-sm text-stone-700 transition hover:border-accent/35 hover:text-accent dark:border-white/10 dark:bg-white/[0.03] dark:text-night-copy dark:hover:text-accent-soft"
      state={navigationState} to={getBookDetailPath(book.id)}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0">
        <span className="block text-xs text-stone-500 dark:text-night-soft">{label}</span>
        <span className="my-1 block break-words font-medium [overflow-wrap:anywhere]">{book.title}</span>
      </span>
    </Link>
  );
}
