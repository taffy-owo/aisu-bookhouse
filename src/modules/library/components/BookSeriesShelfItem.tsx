import { hasBookReadingHistory } from '../../books/services/bookProgress';
import { ChevronDown, ChevronUp, Layers3 } from 'lucide-react';
import { useId, useLayoutEffect, useRef } from 'react';
import { BookCard, BookCover, BookListItem, getReaderRouteForBook } from '../../books';
import type { Book } from '../../books';
import { cn } from '../../../shared/utils/cn';
import type { LibraryShelfItem } from '../services/bookSeries';

type LibrarySeriesItem = Extract<LibraryShelfItem, { kind: 'series' }>;

interface SeriesGroupProps {
  isBookActionPending?: (bookId: string) => boolean;
  isExpanded: boolean;
  onDeleteBook?: (book: Book) => void;
  onToggleDisliked?: (book: Book) => void;
  onToggle: () => void;
  series: LibrarySeriesItem;
}

export function BookSeriesGridGroup({ isBookActionPending, isExpanded, onDeleteBook, onToggle, onToggleDisliked, series }: SeriesGroupProps) {
  const panelId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const revealRequestedRef = useRef(false);
  const stats = getSeriesStats(series);

  useLayoutEffect(() => {
    if (!revealRequestedRef.current) return;
    revealRequestedRef.current = false;
    const section = sectionRef.current;
    const firstBook = section?.querySelector<HTMLElement>('[data-book-id]');
    if (!isExpanded || !section || !firstBook) return;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const toolbar = document.querySelector<HTMLElement>('.topbar-shell');
    const navigation = document.querySelector<HTMLElement>('.mobile-bottom-nav');
    const top = Math.max(viewportTop, toolbar?.getBoundingClientRect().bottom ?? viewportTop) + 12;
    const bottom = Math.min(viewportBottom, navigation?.getClientRects().length ? navigation.getBoundingClientRect().top : viewportBottom) - 12;
    const bounds = section.getBoundingClientRect();
    // Reveal books after an explicit expansion, without changing a series
    // restored by Back or a background refresh. Keep the stable toggle focused.
    if (bounds.top < top || firstBook.getBoundingClientRect().bottom > bottom) {
      window.scrollBy({ top: bounds.top - top, behavior: 'instant' });
    }
  }, [isExpanded]);

  return (
    <section className={isExpanded ? 'col-span-full border-y border-stone-200 py-5 dark:border-white/10' : 'group relative min-w-0'} data-expanded-series-book={isExpanded ? series.books[0]?.id : undefined} ref={sectionRef}>
      <div className={isExpanded ? 'mb-5 flex items-center justify-between gap-3' : undefined}>
        {isExpanded && (
          <div className="min-w-0" key="heading">
            <div className="flex items-center gap-2 text-xs font-medium text-accent dark:text-peach">
              <Layers3 className="h-3.5 w-3.5" />
              <span>已加载 {series.books.length} 卷</span>
            </div>
            <h2 className="mt-1 text-balance break-words font-display text-lg font-semibold text-stone-950 [overflow-wrap:anywhere] dark:text-night-ink">{series.label}</h2>
          </div>
        )}
        <button
          aria-controls={panelId}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? '收起' : '展开'}《${series.label}》系列`}
          className={cn('focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40', isExpanded ? 'grid h-9 w-9 shrink-0 place-items-center text-stone-400 transition hover:text-accent' : 'block w-full min-w-0 text-left')}
          key="toggle"
          onClick={() => { revealRequestedRef.current = !isExpanded; onToggle(); }}
          title={isExpanded ? '收起系列' : series.label}
          type="button"
        >
          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <>
            <SeriesCoverStack books={series.books} />
            <span className="mt-2.5 flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 min-h-[2.8em] break-words font-display text-[13px] leading-snug transition-colors [overflow-wrap:anywhere] group-hover:text-accent sm:text-sm">{series.label}</span>
                <span className="mt-0.5 block truncate text-[11px] text-ink/55 dark:text-stone-400" title={stats.author}>{stats.author}</span>
                <span className="mt-1.5 block text-[10px] leading-none text-ink/50 sm:text-[11px] dark:text-stone-500">{stats.summary}</span>
              </span>
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-stone-400 transition-colors group-hover:text-accent" />
            </span>
          </>}
        </button>
      </div>
      {isExpanded && (
        <div className="book-grid grid grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 sm:grid-cols-4 sm:gap-x-4 sm:gap-y-8 md:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7" id={panelId}>
          {series.books.map((book) => (
            <BookCard
              book={book}
              isActionPending={isBookActionPending?.(book.id)}
              key={book.id}
              onRequestDelete={onDeleteBook}
              onToggleDisliked={onToggleDisliked}
              readerPath={getReaderRouteForBook(book)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function BookSeriesListGroup({ isBookActionPending, isExpanded, onDeleteBook, onToggle, onToggleDisliked, series }: SeriesGroupProps) {
  const panelId = useId();
  const stats = getSeriesStats(series);

  return (
    <section className="border-b border-stone-200 dark:border-white/10" data-expanded-series-book={isExpanded ? series.books[0]?.id : undefined}>
      <button
        aria-controls={panelId}
        aria-expanded={isExpanded}
        className="flex min-h-28 w-full items-center gap-4 py-4 text-left transition hover:bg-black/[0.01] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 dark:hover:bg-white/[0.01]"
        onClick={onToggle}
        title={series.label}
        type="button"
      >
        <SeriesCoverStack books={series.books} compact />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <Layers3 className="h-4 w-4 shrink-0 text-accent dark:text-peach" />
            <span className="min-w-0 line-clamp-2 break-words font-display text-base font-semibold text-stone-900 [overflow-wrap:anywhere] dark:text-night-ink">{series.label}</span>
          </span>
          <span className="mt-1 block truncate text-xs text-stone-500 dark:text-stone-400" title={stats.author}>{stats.author}</span>
          <span className="mt-2 block text-[11px] text-stone-500 dark:text-stone-500">{stats.summary}</span>
        </span>
        <ChevronDown className={cn('mr-2 h-4 w-4 shrink-0 text-stone-400 transition-transform duration-200', isExpanded && 'rotate-180')} />
      </button>
      {isExpanded && (
        <div className="border-t border-stone-100 pl-3 sm:pl-6 dark:border-white/[0.06]" id={panelId}>
          {series.books.map((book) => (
            <BookListItem book={book} isActionPending={isBookActionPending?.(book.id)} key={book.id} onRequestDelete={onDeleteBook} onToggleDisliked={onToggleDisliked} readerPath={getReaderRouteForBook(book)} />
          ))}
        </div>
      )}
    </section>
  );
}

function SeriesCoverStack({ books, compact = false }: { books: LibrarySeriesItem['books']; compact?: boolean }) {
  const visibleBooks = books.slice(0, 3);
  return (
    <span className={cn('relative block shrink-0', compact ? 'h-24 w-[74px]' : 'aspect-[0.68] w-full')}>
      {[...visibleBooks].reverse().map((book, reverseIndex) => {
        const originalIndex = visibleBooks.length - reverseIndex - 1;
        return (
          <span
            aria-hidden={originalIndex > 0 || undefined}
            className={cn('absolute bottom-0 left-0 block transition-transform duration-200', compact ? 'h-24 w-16' : 'w-full')}
            key={book.id}
            style={{ transform: `translate(${originalIndex * 5}px, -${originalIndex * (compact ? 2 : 4)}px) rotate(${originalIndex * 0.8}deg)`, zIndex: visibleBooks.length - originalIndex }}
          >
            <BookCover book={book} size={compact ? 'sm' : 'md'} />
          </span>
        );
      })}
      <span aria-label={`已加载 ${books.length} 卷`} className={cn('absolute z-40 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-stone-950/[0.72] font-medium text-white shadow-sm backdrop-blur-sm', compact ? 'bottom-1 right-0 px-1.5 py-1 text-[9px]' : 'bottom-2 right-0 px-2 py-1 text-[10px]')}>
        <Layers3 className="h-3 w-3" />
        {compact ? `${books.length}卷` : `已加载 ${books.length} 卷`}
      </span>
    </span>
  );
}

function getSeriesStats(series: LibrarySeriesItem): { author: string; summary: string } {
  const finishedCount = series.books.filter((book) => book.progressPercent >= 100).length;
  const readingCount = series.books.filter((book) => hasBookReadingHistory(book) && book.progressPercent < 100).length;
  const publicationLabel = series.books.some((book) => book.publicationStatus === 'ongoing') ? '连载中' : '已完结';
  const summaryParts = [publicationLabel];
  if (finishedCount > 0) summaryParts.push(`已读 ${finishedCount}`);
  if (readingCount > 0) summaryParts.push(`${readingCount} 卷阅读中`);
  if (finishedCount === 0 && readingCount === 0) summaryParts.push('全部未读');
  return {
    author: series.books[0]?.author?.trim() || '佚名',
    summary: summaryParts.join(' · '),
  };
}
