import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '../../../shared/utils/cn';
import type { ReaderTheme } from '../types/reader';

interface ReaderFindBarProps {
  activeMatchIndex: number;
  isDark?: boolean;
  theme?: ReaderTheme;
  matchCount: number;
  onChangeQuery: (query: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  query: string;
}

export function ReaderFindBar({ activeMatchIndex, isDark = false, theme = isDark ? 'dark' : 'paper', matchCount, onChangeQuery, onClose, onNext, onPrevious, query }: ReaderFindBarProps) {
  const hasMatches = matchCount > 0;
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      frame = 0;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const barWidth = Math.max(1, Math.min(620, width - (width < 200 ? 8 : 24)));
      const header = bar.closest('.reader-with-reading-status')?.querySelector<HTMLElement>('.reader-chrome-top');
      const footer = bar.closest('.reader-with-reading-status')?.querySelector<HTMLElement>('.reader-bottom-bar');
      const headerBottom = header && !header.inert ? header.getBoundingClientRect().bottom : top;
      bar.dataset.viewportCompact = String(width < 480);
      bar.dataset.viewportNarrow = String(width < 200);
      bar.style.width = `${barWidth}px`;
      bar.style.left = `${left + (width - barWidth) / 2}px`;
      bar.style.right = 'auto';
      bar.style.transform = 'none';
      bar.style.maxHeight = `${Math.max(1, height - 24)}px`;
      // Position independently of match results, including an empty search.
      const barHeight = bar.getBoundingClientRect().height;
      const footerTop = footer && !footer.inert ? footer.getBoundingClientRect().top : top + height;
      // A short viewport needs room to show the match, not only the search UI.
      const preferredTop = footerTop - headerBottom - 12 - barHeight < 88 ? top + 12 : headerBottom + 12;
      bar.style.top = `${Math.max(top + 12, Math.min(preferredTop, top + height - barHeight - 12))}px`;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(bar);
    const header = bar.closest('.reader-with-reading-status')?.querySelector('.reader-chrome-top');
    if (header) observer.observe(header);
    const footer = bar.closest('.reader-with-reading-status')?.querySelector('.reader-bottom-bar');
    if (footer) observer.observe(footer);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    update();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, []);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return (
    <div
      ref={barRef}
      aria-label="当前章查找"
      role="search"
      className={cn(
        `reader-find-bar reader-theme-${theme}`,
        'fixed left-3 right-3 z-[80] overflow-y-auto overscroll-contain mx-auto grid max-w-2xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-2xl border px-3 py-2 shadow-soft backdrop-blur-2xl sm:left-1/2 sm:right-auto sm:w-[min(620px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:grid-cols-[minmax(0,1fr)_auto_auto]',
      )}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}
    >
      <label className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
        <Search aria-hidden className="h-4 w-4 shrink-0 opacity-50" />
        <input
          aria-label="在当前章查找"
          aria-describedby="reader-find-result-count"
          ref={inputRef}
          className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-current/40 sm:text-sm"
          onChange={(event) => onChangeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey) onPrevious();
              else onNext();
            }
          }}
          placeholder="在当前章查找"
          type="search"
          value={query}
        />
      </label>
      <div className="reader-find-results col-span-2 row-start-2 flex min-w-0 items-center justify-between gap-2 border-t border-current/10 pt-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:border-0 sm:pt-0">
        <span aria-live="polite" className="reader-find-result-count min-w-14 flex-1 text-xs tabular-nums opacity-65 sm:text-right" id="reader-find-result-count">
          {query.trim() ? (hasMatches ? `${activeMatchIndex + 1}/${matchCount}` : '未找到匹配') : '输入后定位正文'}
        </span>
        <button aria-label="上一个匹配" title="上一个匹配（Shift+Enter）" className="reader-chrome-action grid h-11 w-11 shrink-0 place-items-center rounded-xl disabled:opacity-35" disabled={!hasMatches} onClick={onPrevious} type="button"><ChevronUp className="h-4 w-4" /></button>
        <button aria-label="下一个匹配" title="下一个匹配（Enter）" className="reader-chrome-action grid h-11 w-11 shrink-0 place-items-center rounded-xl disabled:opacity-35" disabled={!hasMatches} onClick={onNext} type="button"><ChevronDown className="h-4 w-4" /></button>
      </div>
      <button aria-label="关闭查找" className="reader-find-close reader-chrome-action col-start-2 row-start-1 grid h-11 w-11 shrink-0 place-items-center rounded-xl sm:col-start-3" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
    </div>
  );
}
