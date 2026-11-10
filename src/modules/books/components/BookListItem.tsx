import { ArrowRight, Check, Loader2, Play, ThumbsDown, Trash2, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { getBookDetailPath } from '../../../config/routes';
import { LinkButton } from '../../../shared/components/LinkButton';
import { BookCover } from './BookCover';
import { BookSelectionControl } from './BookSelectionControl';
import type { Book } from '../types/book';
import { getBrowserReaderAvailability } from '../services/readerAvailability';
import { getPublicationStatusLabel } from '../services/bookLength';
import { getBookProgressLabel, type BookProgressTone } from '../services/bookProgress';

import { HAIRLINE } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';

interface BookListItemProps {
  book: Book;
  isActionPending?: boolean;
  footer?: ReactNode;
  isSelected?: boolean;
  onRequestDelete?: (book: Book) => void;
  onSelect?: (bookId: string) => void;
  onToggleDisliked?: (book: Book) => void;
  readerPath: string;
  selectionMode?: boolean;
}

export function BookListItem({ book, footer, isActionPending = false, isSelected = false, onRequestDelete, onSelect, onToggleDisliked, readerPath, selectionMode = false }: BookListItemProps) {
  const navigationState = createCollectionLinkState(useLocation());
  const availability = getBrowserReaderAvailability(book);
  const actionPath = availability.canReadInBrowser ? readerPath : availability.entryPath;
  const progress = getBookProgressLabel(book.progressPercent, book.lastReadAt);
  const publicationLabel = getPublicationStatusLabel(book);
  const author = book.author?.trim() || '佚名';

  return (
    <article
      data-book-id={book.id}
      className={cn(
        'book-list-item relative flex flex-col gap-3 border-b py-4 transition hover:bg-black/[0.01] dark:hover:bg-white/[0.01]',
        HAIRLINE,
        selectionMode && 'cursor-pointer rounded-lg px-3 outline outline-1 outline-transparent',
        selectionMode && isSelected && 'border-transparent bg-accent/10 outline-accent/45 dark:bg-peach/10 dark:outline-peach/45',
      )}
    >
      {selectionMode && <BookSelectionControl bookId={book.id} title={book.title} isSelected={isSelected} onSelect={onSelect} />}
      <div inert={selectionMode} className="book-list-main flex gap-4">
        <Link className="book-list-cover relative shrink-0" state={navigationState} to={getBookDetailPath(book.id)}>
          <BookCover book={book} size="sm" />
          {selectionMode && (
            <span className={cn('absolute right-1 top-1 z-20 grid h-6 w-6 place-items-center rounded-full border text-white shadow-sm backdrop-blur-sm', isSelected ? 'border-accent bg-accent' : 'border-white/80 bg-black/35')}>
              {isSelected && <Check className="h-3.5 w-3.5" />}
            </span>
          )}
        </Link>
        <div className="book-list-content min-w-0 flex-1 py-0.5">
          <div className="flex flex-wrap items-center gap-2 relative group/title">
            <Link aria-label={book.title} className="min-w-0 line-clamp-2 break-words font-display text-base font-semibold text-stone-900 hover:text-accent dark:text-night-ink dark:hover:text-accent-soft transition" state={navigationState} to={getBookDetailPath(book.id)} title={book.title}>
              {book.title}
            </Link>
            {book.isOwned !== false && (book.sourceUpdateCount ?? 0) > 0 && (
              <span className="shrink-0 rounded-full bg-sakura px-2 py-1 text-[10px] font-semibold leading-none text-accent dark:bg-plum/55 dark:text-peach">原作 +{book.sourceUpdateCount} 话</span>
            )}
            <span aria-hidden="true" className="book-title-tooltip absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 block w-max max-w-[min(280px,calc(100vw-16px))] px-3 py-2 bg-stone-900/95 dark:bg-stone-950/95 text-white text-xs leading-normal rounded-lg shadow-xl opacity-0 scale-95 group-hover/title:opacity-100 group-hover/title:scale-100 group-focus-within/title:opacity-100 group-focus-within/title:scale-100 transition-all duration-200 pointer-events-none z-50 break-all select-none backdrop-blur-sm border border-white/10 text-center font-normal dark:text-night-ink">
              {book.title}
              <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-900/95 dark:border-t-stone-950/95" />
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400" title={`${author}${progress.tone === 'inProgress' && book.currentChapter ? ` · ${book.currentChapter}` : ''}`}>
            {author}{progress.tone === 'inProgress' && book.currentChapter ? ` · ${book.currentChapter}` : ''}
          </p>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-stone-600 dark:text-night-soft">
            <span className={cn('font-semibold', progressToneClass[progress.tone])}>{progress.label}</span>
            {book.publicationStatus === 'ongoing' && <span className="text-amber-800 dark:text-night-soft">· {publicationLabel}</span>}
          </div>
          <div className="book-list-actions mt-3 flex gap-2">
            <LinkButton className="min-h-11 px-3 text-xs" icon={availability.canReadInBrowser ? <Play className="h-3.5 w-3.5 fill-current" /> : <ArrowRight className="h-3.5 w-3.5" />} title={availability.reason} state={navigationState} to={actionPath} variant="primary">
              {availability.canReadInBrowser ? '阅读' : '查看详情'}
            </LinkButton>
            {availability.canReadInBrowser && (
              <LinkButton className="min-h-11 px-3 text-xs" state={navigationState} to={getBookDetailPath(book.id)} variant="secondary">
                详情
              </LinkButton>
            )}
            {onToggleDisliked && !selectionMode && (
              <button
                aria-busy={isActionPending}
                aria-label={book.disliked ? `恢复《${book.title}》到书架` : `不喜欢《${book.title}》`}
                className="grid h-9 w-9 place-items-center rounded-xl text-stone-400 transition hover:bg-stone-100 hover:text-accent disabled:cursor-wait disabled:opacity-60 dark:text-stone-500 dark:hover:bg-white/[0.06] dark:hover:text-peach"
                disabled={isActionPending}
                onClick={() => onToggleDisliked(book)}
                title={book.disliked ? '恢复显示' : '不喜欢'}
                type="button"
              >
                {isActionPending ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : book.disliked ? <Undo2 className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
              </button>
            )}
            {onRequestDelete && !selectionMode && (
              <button
                aria-label={`删除《${book.title}》`}
                className="grid h-9 w-9 place-items-center rounded-xl text-stone-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-wait disabled:opacity-60 dark:text-stone-500 dark:hover:bg-red-400/10 dark:hover:text-red-300"
                disabled={isActionPending}
                onClick={() => onRequestDelete(book)}
                title="删除图书"
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
      {footer && <div inert={selectionMode} className={cn('book-list-footer mt-2 border-t pt-3', HAIRLINE)}>{footer}</div>}
    </article>
  );
}

const progressToneClass: Record<BookProgressTone, string> = {
  finished: 'text-emerald-700 dark:text-emerald-300',
  inProgress: 'text-accent dark:text-accent-soft/[0.85]',
  unread: 'text-stone-500 dark:text-stone-400',
};
