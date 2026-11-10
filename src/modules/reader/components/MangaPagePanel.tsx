import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import { X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../../shared/utils/cn';
import { normalizeRequestedPageIndex } from '../utils/readerLocator';
import { useReaderPanelDismiss } from '../hooks/useReaderPanelDismiss';

interface MangaPagePanelProps {
  currentPageIndex: number;
  onClose: () => void;
  onSelectPage: (pageIndex: number) => void;
  pageCount: number;
}

export function MangaPagePanel({ currentPageIndex, onClose, onSelectPage, pageCount }: MangaPagePanelProps) {
  const panelRef = useReaderPanelDismiss({ onClose });
  const viewportRef = useDialogViewport();
  const pageIndexes = Array.from({ length: pageCount }, (_, index) => index + 1);
  const [pageInputValue, setPageInputValue] = useState(String(currentPageIndex));
  const requestedPageIndex = normalizeRequestedPageIndex(pageInputValue, pageCount);
  const composingRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const currentPageButtonRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    // Center only this list, so page navigation cannot move the reader or header.
    const list = listRef.current;
    const current = currentPageButtonRef.current;
    if (!list || !current) return;
    const row = current.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    list.scrollTop += (row.top + row.bottom - bounds.top - bounds.bottom) / 2;
  }, [currentPageIndex, pageCount]);


  const handleJumpSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composingRef.current || !requestedPageIndex) {
      return;
    }

    onSelectPage(requestedPageIndex);
    onClose();
  };

  return (
    <div ref={viewportRef} className="reader-panel-backdrop reader-page-backdrop viewport-dialog fixed inset-0 z-[90]" onClick={onClose}>
      <aside
        aria-label="页目录"
        aria-modal="true"
        className="reader-panel-sheet reader-page-panel reader-theme-dark absolute inset-x-0 bottom-0 flex w-full flex-col bg-[color:var(--reader-page)] text-[color:var(--reader-ink)] sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:max-w-sm sm:w-[380px]"
        onClick={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="reader-panel-heading flex items-center justify-between px-5 pb-4 pt-5">
          <div>
            <p className="reader-muted text-xs">目录</p>
            <h2 className="text-base font-semibold">图片页</h2>
          </div>
          <button aria-label="关闭页目录" className="grid h-11 w-11 shrink-0 place-items-center rounded-full transition hover:bg-current/10" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form className="reader-page-jump flex items-center gap-2 px-5 pb-4" onSubmit={handleJumpSubmit}>
          <input
            aria-label="输入页码"
            className="reader-line-input min-h-11 min-w-0 flex-1 bg-transparent px-1 text-base outline-none sm:text-sm"
            inputMode="numeric"
            onChange={(event) => setPageInputValue(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }}
            placeholder={`1-${pageCount}`}
            type="text"
            value={pageInputValue}
          />
          <button
            className="min-h-11 bg-[color:var(--reader-accent)] px-4 text-sm font-medium text-[color:var(--reader-page)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!requestedPageIndex}
            type="submit"
          >
            跳转
          </button>
        </form>
        <div ref={listRef} className="reader-page-list min-h-0 flex-1 overflow-y-auto p-4 reader-scrollbar">
          <div className="grid gap-2 text-sm" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(44px, ${String(pageCount).length + 2}ch)), 1fr))` }}>
            {pageIndexes.map((pageIndex) => (
              <button
                className={cn(
                  'reader-page-index relative grid h-11 place-items-center text-sm transition',
                  pageIndex === currentPageIndex ? 'reader-page-index-current text-[color:var(--reader-accent)]' : 'hover:text-[color:var(--reader-accent)]',
                )}
                aria-current={pageIndex === currentPageIndex ? 'page' : undefined}
                ref={pageIndex === currentPageIndex ? currentPageButtonRef : undefined}
                key={pageIndex}
                onClick={() => {
                  onSelectPage(pageIndex);
                  onClose();
                }}
                type="button"
              >
                {pageIndex}
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
