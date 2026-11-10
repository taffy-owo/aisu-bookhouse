import { ArrowRight, Check, Play } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { getBookDetailPath } from '../../../config/routes';
import { cn } from '../../../shared/utils/cn';
import { getPublicationStatusLabel } from '../services/bookLength';
import { getBookProgressLabel, type BookProgressTone } from '../services/bookProgress';
import { getBrowserReaderAvailability } from '../services/readerAvailability';
import type { Book } from '../types/book';
import { BookCover } from './BookCover';
import { BookActionsMenu } from './BookActionsMenu';
import { BookSelectionControl } from './BookSelectionControl';

interface BookCardProps {
  book: Book;
  isActionPending?: boolean;
  isSelected?: boolean;
  onRequestDelete?: (book: Book) => void;
  onSelect?: (bookId: string) => void;
  onToggleDisliked?: (book: Book) => void;
  readerPath: string;
  selectionMode?: boolean;
}

export function BookCard({ book, isActionPending = false, isSelected = false, onRequestDelete, onSelect, onToggleDisliked, readerPath, selectionMode = false }: BookCardProps) {
  const navigationState = createCollectionLinkState(useLocation());
  const availability = getBrowserReaderAvailability(book);
  const actionPath = availability.canReadInBrowser ? readerPath : availability.entryPath;
  const progress = getBookProgressLabel(book.progressPercent, book.lastReadAt);
  const publicationLabel = getPublicationStatusLabel(book);

  return (
    <article
      data-book-id={book.id}
      className={cn(
        'book-card group relative min-w-0 rounded-lg',
        selectionMode && 'cursor-pointer px-2 pb-3 pt-2 outline outline-1 outline-transparent transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
        selectionMode && isSelected && 'bg-accent/10 outline-accent/45 dark:bg-peach/10 dark:outline-peach/45',
      )}
    >
      {selectionMode && <BookSelectionControl bookId={book.id} title={book.title} isSelected={isSelected} onSelect={onSelect} />}
      {(onRequestDelete || onToggleDisliked) && !selectionMode && (
        <BookActionsMenu book={book} isPending={isActionPending} onRequestDelete={onRequestDelete} onToggleDisliked={onToggleDisliked} />
      )}
      <div inert={selectionMode} className="relative transition-transform duration-200 ease-out md:group-hover:-translate-y-0.5">
        <Link className="block" state={navigationState} to={getBookDetailPath(book.id)}>
          <div className="relative overflow-hidden rounded-xl">
            <BookCover book={book} />
          </div>
          {selectionMode && (
            <span className={cn('absolute right-2 top-2 z-20 grid h-7 w-7 place-items-center rounded-full border text-white shadow-dusk-sm backdrop-blur-sm', isSelected ? 'border-accent bg-accent' : 'border-white/80 bg-black/35')}>
              {isSelected && <Check className="h-4 w-4" />}
            </span>
          )}
        </Link>
        <Link
          aria-label={`${availability.canReadInBrowser ? '阅读' : '查看详情：'}${book.title}`}
          className="book-card-read group/book-read absolute bottom-2 right-2 z-20 grid h-11 w-11 place-items-center rounded-full text-white opacity-100 transition-opacity duration-200 md:pointer-events-none md:h-8 md:w-8 md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100"
          title={availability.reason}
          state={navigationState} to={actionPath}
        >
          <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full bg-stone-950/65 transition-colors group-hover/book-read:bg-accent">
            {availability.canReadInBrowser ? <Play className="h-3 w-3 fill-current" /> : <ArrowRight className="h-3 w-3" />}
          </span>
        </Link>
      </div>
      <div inert={selectionMode} className="book-card-caption mt-2.5">
        <div className="group/title relative min-w-0">
          <Link aria-label={book.title} className="line-clamp-2 min-h-[2.8em] break-words font-display text-[13px] leading-[1.4] transition-colors hover:text-accent sm:text-sm" state={navigationState} to={getBookDetailPath(book.id)} title={book.title}>
            {book.title}
          </Link>
          <span aria-hidden="true" className="book-title-tooltip pointer-events-none absolute bottom-full left-1/2 z-50 mb-2.5 block w-max max-w-[min(240px,calc(100vw-16px))] -translate-x-1/2 select-none break-all rounded-lg border border-white/10 bg-stone-900/95 px-3 py-2 text-center text-xs font-normal leading-normal text-white opacity-0 shadow-xl backdrop-blur-sm transition-all duration-200 scale-95 group-hover/title:scale-100 group-hover/title:opacity-100 group-focus-within/title:scale-100 group-focus-within/title:opacity-100 dark:bg-stone-950/95 dark:text-night-ink">
            {book.title}
            <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-stone-900/95 dark:border-t-stone-950/95" />
          </span>
          <div className="mt-0.5 truncate text-[11px] text-ink/55 dark:text-stone-400" title={book.author?.trim() || '佚名'}>{book.author?.trim() || '佚名'}</div>
          {book.isOwned !== false && (book.sourceUpdateCount ?? 0) > 0 && (
            <span className="mt-1.5 inline-flex rounded-full bg-sakura px-2 py-1 text-[10px] font-semibold leading-none text-accent dark:bg-plum/55 dark:text-peach">
              原作 +{book.sourceUpdateCount} 话
            </span>
          )}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-none text-ink/65 dark:text-night-soft">
            <span className={cn('shrink-0 font-medium', progressToneClass[progress.tone])}>{progress.label}</span>
            {book.publicationStatus === 'ongoing' && <span className="shrink-0 text-amber-800 dark:text-night-soft">· {publicationLabel}</span>}
          </div>
        </div>
      </div>
    </article>
  );
}

const progressToneClass: Record<BookProgressTone, string> = {
  finished: 'text-emerald-700 dark:text-emerald-300',
  inProgress: 'text-accent dark:text-accent-soft/[0.85]',
  unread: 'text-stone-500 dark:text-stone-400',
};
