import { useEffect, useMemo, useState } from 'react';
import { useNavigationSnapshot } from '../../../shared/navigation/useNavigationSnapshot';
import { BookCard, getReaderRouteForBook } from '../../books';
import type { Book } from '../../books';
import { groupBooksForLibraryShelf } from '../services/bookSeries';
import { BookSeriesGridGroup } from './BookSeriesShelfItem';

interface BookGridProps {
  books: Book[];
  compact?: boolean;
  groupSeries?: boolean;
  isBookActionPending?: (bookId: string) => boolean;
  isBookSelected?: (bookId: string) => boolean;
  onDeleteBook?: (book: Book) => void;
  onSelectBook?: (bookId: string) => void;
  onToggleDisliked?: (book: Book) => void;
  selectionMode?: boolean;
}

export function BookGrid({ books, compact = false, groupSeries = false, isBookActionPending, isBookSelected, onDeleteBook, onSelectBook, onToggleDisliked, selectionMode = false }: BookGridProps) {
  const [expandedSeriesKey, setExpandedSeriesKey] = useState<string | null | undefined>(undefined);
  const navigationSnapshot = useNavigationSnapshot();
  const gridClassName = compact
    ? 'grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 sm:grid-cols-4 sm:gap-x-4 sm:gap-y-8 xl:grid-cols-6'
    : 'grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 sm:grid-cols-4 sm:gap-x-4 sm:gap-y-8 md:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7';
  const shelfItems = useMemo(
    () => groupSeries && !selectionMode
      ? groupBooksForLibraryShelf(books)
      : books.map((book) => ({ book, kind: 'book' as const })),
    [books, groupSeries, selectionMode],
  );
  const restoredSeries = shelfItems.find((item) => item.kind === 'series' && item.books.some((book) => book.id === navigationSnapshot?.expandedSeriesBookId));
  const restoredSeriesKey = restoredSeries?.kind === 'series' ? restoredSeries.key : null;
  const activeSeriesKey = expandedSeriesKey === undefined ? restoredSeriesKey : expandedSeriesKey;

  useEffect(() => {
    if (!expandedSeriesKey || shelfItems.some((item) => item.kind === 'series' && item.key === expandedSeriesKey)) return;
    setExpandedSeriesKey(null);
  }, [expandedSeriesKey, shelfItems]);

  return (
    <div className={`book-grid grid ${gridClassName}${compact ? ' book-grid--compact' : ''}`}>
      {shelfItems.map((item) => item.kind === 'series' ? (
        <BookSeriesGridGroup
          isBookActionPending={isBookActionPending}
          isExpanded={activeSeriesKey === item.key}
          key={`series:${item.key}`}
          onDeleteBook={onDeleteBook}
          onToggleDisliked={onToggleDisliked}
          onToggle={() => setExpandedSeriesKey(activeSeriesKey === item.key ? null : item.key)}
          series={item}
        />
      ) : (
          <BookCard
            book={item.book}
            isActionPending={isBookActionPending?.(item.book.id)}
            isSelected={isBookSelected?.(item.book.id) ?? false}
            key={item.book.id}
            onRequestDelete={onDeleteBook}
            onSelect={onSelectBook}
            onToggleDisliked={onToggleDisliked}
            readerPath={getReaderRouteForBook(item.book)}
            selectionMode={selectionMode}
          />
        ))}
    </div>
  );
}
