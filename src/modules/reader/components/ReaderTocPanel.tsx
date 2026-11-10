import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import { ArrowUpRight, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { getBookDetailPath } from '../../../config/routes';
import type { ReaderTheme, ReaderTocItem } from '../types/reader';
import { cn } from '../../../shared/utils/cn';
import { useReaderPanelDismiss } from '../hooks/useReaderPanelDismiss';
import { filterReaderTocItems } from '../utils/readerLocator';

interface ReaderTocPanelProps {
  bookId?: string;
  bookTitle?: string;
  author?: string;
  isDocked?: boolean;
  currentChapterIndex: number;
  currentChapterTitle?: string;
  isDark?: boolean;
  theme?: ReaderTheme;
  onClose: () => void;
  onSelectChapter: (chapterIndex: number) => void;
  toc: ReaderTocItem[];
}

export function ReaderTocPanel({ bookId, bookTitle, author, isDocked = false, currentChapterIndex, currentChapterTitle, isDark = false, theme = isDark ? 'dark' : 'paper', onClose, onSelectChapter, toc }: ReaderTocPanelProps) {
  const navigationState = createCollectionLinkState(useLocation());
  const [query, setQuery] = useState('');
  const [locateRequest, setLocateRequest] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filteredToc = useMemo(() => filterReaderTocItems(toc, query), [query, toc]);
  const hasNestedToc = useMemo(() => toc.some((item) => (item.level ?? 1) > 1), [toc]);
  const hasCurrentChapter = toc.some((item) => item.index === currentChapterIndex);
  const shouldShowPinnedCurrentChapter = Boolean(!query.trim() && currentChapterTitle && !hasCurrentChapter);
  const currentChapterButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useReaderPanelDismiss({ onClose, isOpen: !isDocked });
  const viewportRef = useDialogViewport(!isDocked);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isDocked) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isDocked]);

  useLayoutEffect(() => {
    // Keep centering inside the list; scrolling every ancestor can move the
    // reader or hide the panel controls when the keyboard is open.
    const list = listRef.current;
    const current = currentChapterButtonRef.current;
    if (!list || !current) return;
    const row = current.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    list.scrollTop += (row.top + row.bottom - bounds.top - bounds.bottom) / 2;
  }, [currentChapterIndex, filteredToc, hasCurrentChapter, isDocked, locateRequest]);

  return (
    <div ref={viewportRef} className={isDocked ? 'reader-toc-dock' : 'reader-panel-backdrop reader-toc-backdrop viewport-dialog fixed inset-0 z-[90]'} onClick={isDocked ? undefined : onClose}>
      <aside
        id="reader-chapter-catalog"
        aria-label="章节目录"
        aria-modal={isDocked ? undefined : true}
        ref={panelRef}
        role={isDocked ? 'complementary' : 'dialog'}
        tabIndex={-1}
        className={cn(
          isDocked ? 'reader-toc-docked flex flex-col focus:outline-none' : 'reader-panel-sheet absolute inset-x-0 bottom-0 flex w-full flex-col focus:outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:max-w-sm sm:w-[380px]',
          `reader-toc-panel reader-theme-${theme}`,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {bookTitle && (
          <div className="reader-toc-book px-5 pb-4 pt-5">
            <p className="line-clamp-3 text-sm font-semibold leading-6">{bookTitle}</p>
            {author && <p className="reader-muted mt-1 truncate text-xs">{author}</p>}
            {bookId && <Link className="mt-2 inline-flex min-h-8 items-center gap-1 text-xs text-[color:var(--reader-accent)]" state={navigationState} to={getBookDetailPath(bookId)}>图书详情<ArrowUpRight className="h-3 w-3" /></Link>}
          </div>
        )}
        <div className="reader-panel-heading flex items-center justify-between px-5 pb-4 pt-5">
          <div>
            <p className="text-xs text-current/70">目录</p>
            <h2 className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold">章节列表 <span className="reader-muted whitespace-nowrap text-xs font-normal">共 {toc.length} 话</span></h2>
          </div>
          <button aria-label="关闭目录" className="grid h-11 w-11 shrink-0 place-items-center rounded-full transition hover:bg-current/10" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="reader-toc-search px-5 pb-3">
          <label className="reader-line-input flex min-h-10 items-center gap-2 px-1 text-sm">
            <Search className="h-4 w-4 shrink-0 opacity-50" />
            <input
              aria-label="搜索章节或序号"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-current/35"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索章节或序号"
              type="search"
              value={query}
            />
          </label>
        </div>
        <div ref={listRef} className="reader-toc-list min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2 reader-scrollbar sm:px-3">
          {shouldShowPinnedCurrentChapter && (
            <button
              aria-current="location"
              ref={currentChapterButtonRef}
              className="reader-toc-item reader-toc-item-current mb-1 flex w-full items-center gap-3 px-3 py-3 text-left text-sm text-accent"
              onClick={() => {
                onSelectChapter(currentChapterIndex);
                if (!isDocked) onClose();
              }}
              type="button"
            >
              <span className="w-10 shrink-0 text-xs opacity-70">{currentChapterIndex}</span>
              <span className="min-w-0 flex-1 truncate">{currentChapterTitle}</span>
              <span className="shrink-0 text-[11px] opacity-65">当前</span>
            </button>
          )}
          {filteredToc.length ? (
            filteredToc.map((item, itemPosition) => {
              const previousSectionTitle = itemPosition > 0 ? filteredToc[itemPosition - 1]?.sectionTitle : undefined;
              const shouldShowSection = Boolean(item.sectionTitle && item.sectionTitle !== previousSectionTitle);
              return (
                <div key={`${item.index}-${item.title}`}>
                  {shouldShowSection && (
                    <p
                      className="px-3 pb-1 pt-4 text-[11px] font-semibold opacity-45"
                      style={{ paddingLeft: `${Math.min(3, Math.max(0, (item.sectionLevel ?? 1) - 1)) * 12 + 12}px` }}
                    >
                      {item.sectionTitle}
                    </p>
                  )}
                  <button
                    className={cn(
                      'reader-toc-item flex w-full items-center gap-3 px-3 py-3 text-left text-sm',
                      item.index === currentChapterIndex ? 'reader-toc-item-current text-accent' : '',
                    )}
                    onClick={() => {
                      onSelectChapter(item.index);
                      if (!isDocked) onClose();
                    }}
                    aria-current={item.index === currentChapterIndex ? 'location' : undefined}
                    ref={item.index === currentChapterIndex ? currentChapterButtonRef : undefined}
                    type="button"
                  >
                    <span className="w-10 shrink-0 text-xs opacity-50">{item.index}</span>
                    <span
                      className={cn('min-w-0 flex-1 truncate', hasNestedToc && (item.level ?? 1) === 1 && 'font-semibold')}
                      style={{ paddingLeft: hasNestedToc ? `${Math.min(3, Math.max(0, (item.level ?? 1) - 1)) * 12}px` : undefined }}
                    >
                      {item.title}
                    </span>
                    {item.index === currentChapterIndex && <span className="shrink-0 text-[11px] opacity-65">当前</span>}
                  </button>
                </div>
              );
            })
          ) : !shouldShowPinnedCurrentChapter ? (
            <p className="px-3 py-8 text-center text-sm text-current/50">{toc.length ? '没有匹配的章节。' : '暂无可显示的目录。'}</p>
          ) : null}
        </div>
        <div className="reader-toc-footer">
          <span className="reader-muted min-w-0 truncate text-xs" title={currentChapterTitle}>正在阅读 · {currentChapterTitle || `第 ${currentChapterIndex} 话`}</span>
          <button className="shrink-0 text-xs" onClick={() => {
            setQuery('');
            setLocateRequest(request => request + 1);
          }} type="button">定位当前</button>
        </div>
      </aside>
    </div>
  );
}
