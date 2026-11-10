import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import { useReaderPanelDismiss } from '../hooks/useReaderPanelDismiss';
import { cn } from '../../../shared/utils/cn';

export function PdfThumbnailSidebar({ currentPage, desktop, id, onClose, onSelect, pageNumbers, renderPage }: {
  currentPage: number; desktop: boolean; id: string; onClose: () => void; onSelect: (page: number) => void;
  pageNumbers: number[]; renderPage: (page: number) => ReactNode;
}) {
  const panelRef = useReaderPanelDismiss({ isOpen: !desktop, onClose });
  const viewportRef = useDialogViewport();
  const listRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current, current = list?.querySelector('[aria-current="page"]');
    if (!list || !current) return;
    const row = current.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    list.scrollTop += (row.top + row.bottom - bounds.top - bounds.bottom) / 2;
  }, [currentPage, pageNumbers.length]);
  useEffect(() => {
    if (!desktop) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault(); onClose();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [desktop, onClose]);

  const panel = <aside aria-label="PDF 页目录" aria-modal={desktop ? undefined : true} id={id} role={desktop ? 'complementary' : 'dialog'} tabIndex={-1} ref={panelRef}
    className="pdf-reader-sidebar reader-theme-dark relative flex h-full w-[168px] shrink-0 flex-col overflow-hidden bg-[color:var(--reader-page)] text-[color:var(--reader-ink)] outline-none" onClick={event => event.stopPropagation()}>
    <div className="flex shrink-0 items-center justify-between gap-1 px-3 py-1">
      <span className="text-xs text-[color:var(--reader-muted)]">页面</span>
      <button aria-label="关闭缩略图" className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-md hover:bg-white/10" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
    </div>
    <div className="pdf-thumbnail-list min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 pb-4 reader-scrollbar" ref={listRef}>
      {pageNumbers.map(page => <button aria-current={page === currentPage ? 'page' : undefined} aria-label={`第 ${page} 页`} data-dialog-autofocus={page === currentPage ? true : undefined} data-pdf-thumbnail-page={page}
        className="pdf-thumbnail-item group block min-h-[44px] w-full rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--reader-accent)]" key={page} onClick={() => onSelect(page)} type="button">
        <span className={cn('pdf-thumbnail-preview mx-auto block overflow-hidden p-1 transition', page === currentPage ? 'bg-[color:var(--reader-accent)]' : 'bg-white/[0.06] group-hover:bg-white/[0.18]')}>{renderPage(page)}</span>
        <span className={cn('pdf-thumbnail-label mt-1.5 block text-[11px] tabular-nums', page === currentPage ? 'text-[color:var(--reader-accent)]' : 'text-[color:var(--reader-muted)]')}>{page}</span>
      </button>)}
    </div>
  </aside>;
  return desktop ? panel : <div className="viewport-dialog fixed z-50 flex bg-black/30" onClick={onClose} ref={viewportRef}>{panel}</div>;
}
