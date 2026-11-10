import { Loader2, MoreHorizontal, ThumbsDown, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../shared/utils/cn';
import type { Book } from '../types/book';
import { focusBookMenuItem } from '../services/bookMenuPosition';
import { useBookMenuPosition } from '../hooks/useBookMenuPosition';

interface BookActionsMenuProps {
  book: Book;
  isPending?: boolean;
  onRequestDelete?: (book: Book) => void;
  onToggleDisliked?: (book: Book) => void;
}

export function BookActionsMenu({ book, isPending = false, onRequestDelete, onToggleDisliked }: BookActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const position = useBookMenuPosition(isOpen, triggerRef, menuRef, () => setIsOpen(false));
  const initialEdge = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const closeAndFocus = () => {
    setIsOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!isOpen || !position) return;
    const buttons = items();
    const focused = buttons.find((button) => button === document.activeElement);
    focusBookMenuItem(focused ?? (initialEdge.current === 'last' ? buttons.at(-1) : buttons[0]));
  }, [isOpen, position]);

  useEffect(() => {
    if (!isOpen) return;
    const dismissOutside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [isOpen]);

  return (
    <div className="absolute right-2 top-2 z-30" ref={rootRef}
      onKeyDown={(event) => {
        if (!isOpen || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeAndFocus();
        } else if (event.key === 'Tab') {
          // Resume the document's normal tab order from the opener, without trapping focus.
          closeAndFocus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = items();
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          focusBookMenuItem(buttons[next]);
        }
      }}
    >
      <button
        ref={triggerRef}
        aria-busy={isPending}
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-haspopup="menu"
        aria-label={`打开《${book.title}》操作菜单`}
        className={cn(
          'group/book-menu grid h-10 w-10 place-items-center rounded-full text-white transition focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/65 disabled:cursor-wait md:h-9 md:w-9',
          isOpen || isPending ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
        )}
        disabled={isPending}
        onClick={() => { initialEdge.current = 'first'; setIsOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (isOpen || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            initialEdge.current = event.key === 'ArrowUp' ? 'last' : 'first';
            setIsOpen(true);
          }
        }}
        type="button"
      >
        <span aria-hidden className="book-card-action-face grid h-8 w-8 place-items-center rounded-full border border-white/35 bg-stone-950/45 shadow-dusk-sm backdrop-blur-md transition-colors group-hover/book-menu:bg-stone-950/70">
          {isPending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <MoreHorizontal className="h-4 w-4" />}
        </span>
      </button>
      {isOpen && createPortal(
        <div ref={menuRef} id={menuId} aria-label={`《${book.title}》操作`} className="book-actions-menu fixed z-[80] w-36 overflow-y-auto overscroll-contain rounded-xl border border-black/10 bg-white/95 p-1.5 text-stone-700 shadow-xl backdrop-blur-xl dark:border-white/10 dark:bg-[#211b25]/95 dark:text-night-copy" role="menu" style={position ?? { visibility: 'hidden' }}>
          {onToggleDisliked && <button
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs transition hover:bg-stone-100 focus-visible:bg-stone-100 focus-visible:outline-none dark:hover:bg-white/[0.06] dark:focus-visible:bg-white/[0.10]"
            onClick={() => { closeAndFocus(); onToggleDisliked(book); }}
            role="menuitem" tabIndex={-1} type="button"
          >
            {book.disliked ? <Undo2 className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
            {book.disliked ? '恢复显示' : '不喜欢'}
          </button>}
          {onRequestDelete && <button
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-red-600 transition hover:bg-red-50 focus-visible:bg-red-50 focus-visible:outline-none dark:text-red-300 dark:hover:bg-red-400/10 dark:focus-visible:bg-red-400/15"
            onClick={() => { closeAndFocus(); onRequestDelete(book); }}
            role="menuitem" tabIndex={-1} type="button"
          ><Trash2 className="h-3.5 w-3.5" />删除图书</button>}
        </div>,
        document.body,
      )}
    </div>
  );
}
