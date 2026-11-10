import { Grid3X3, List } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { cn } from '../../../shared/utils/cn';
import type { BookKind, BookSortKey } from '../../books';

interface LibraryFiltersProps {
  activeKind: BookKind | 'all' | 'favorite' | 'recent' | 'finished' | 'unread' | 'disliked';
  onKindChange: (value: LibraryFiltersProps['activeKind']) => void;
  onSortChange: (value: BookSortKey) => void;
  sort: BookSortKey;
  view?: 'grid' | 'list';
  onViewChange?: (value: 'grid' | 'list') => void;
}

const kindFilters: Array<{ label: string; value: LibraryFiltersProps['activeKind'] }> = [
  { label: '全部', value: 'all' },
  { label: '小说', value: 'novel' },
  { label: '漫画', value: 'manga' },
  { label: 'PDF', value: 'pdf' },
  { label: '图集', value: 'image' },
  { label: '收藏', value: 'favorite' },
  { label: '在读', value: 'recent' },
  { label: '已读', value: 'finished' },
  { label: '未读', value: 'unread' },
  { label: '不喜欢', value: 'disliked' },
];

export function LibraryFilters({ activeKind, onKindChange, onSortChange, sort, view, onViewChange }: LibraryFiltersProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const rail = railRef.current;
    const selected = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!rail || !selected) return;
    const keepActiveVisible = () => {
      if (rail.scrollWidth <= rail.clientWidth) return;
      const bounds = rail.getBoundingClientRect();
      const activeBounds = selected.getBoundingClientRect();
      // Only move this horizontal rail; restoring a filter must not pull
      // the whole book list back to the top.
      if (activeBounds.left < bounds.left + 4) rail.scrollLeft += activeBounds.left - bounds.left - 4;
      else if (activeBounds.right > bounds.right - 4) rail.scrollLeft += activeBounds.right - bounds.right + 4;
    };
    keepActiveVisible();
    const observer = new ResizeObserver(keepActiveVisible);
    observer.observe(rail);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [activeKind]);

  return (
    <div className="library-filters flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
      <div aria-label="图书分类与阅读状态" role="group" ref={railRef} className="library-filter-rail -mx-1 flex w-full min-w-0 gap-1.5 overflow-x-auto px-1 pb-1 sm:w-auto sm:flex-1 sm:flex-wrap sm:gap-2 sm:overflow-visible">
        {kindFilters.map((filter) => (
          <button
            className={cn(
              'min-h-11 shrink-0 rounded-full px-3 py-1.5 text-xs transition sm:px-4 sm:py-2 sm:text-sm lg:min-h-8 lg:px-3 lg:py-1 lg:text-[13px]',
              filter.value === activeKind ? 'bg-accent text-white' : 'bg-stone-100 text-stone-500 hover:bg-stone-200 dark:bg-white/5 dark:text-stone-400 dark:hover:bg-white/10',
            )}
            aria-pressed={filter.value === activeKind}
            key={filter.value}
            onClick={() => onKindChange(filter.value)}
            type="button"
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-start">
        <select
          aria-label="图书排序"
          className="min-h-11 lg:min-h-8 rounded-full border-0 bg-stone-100 px-3 text-xs text-stone-500 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 dark:bg-white/5 dark:text-night-soft"
          onChange={(event) => onSortChange(event.target.value as BookSortKey)}
          value={sort}
        >
          <option className="dark:bg-night" value="recent">最近阅读</option>
          <option className="dark:bg-night" value="created">最近添加</option>
          <option className="dark:bg-night" value="title">书名</option>
          <option className="dark:bg-night" value="progress">阅读进度</option>
          <option className="dark:bg-night" value="chapters">章节数</option>
          <option className="dark:bg-night" value="words">字数</option>
          <option className="dark:bg-night" value="comments">评论数</option>
        </select>
        {view && onViewChange && (
          <div className="flex items-center gap-0.5 rounded-full bg-stone-100 p-0.5 dark:bg-white/5">
            <button
              aria-label="宫格视图"
              aria-pressed={view === 'grid'}
              className={cn(
                'grid h-11 w-11 place-items-center rounded-full transition lg:h-8 lg:w-8',
                view === 'grid' ? 'bg-white text-accent shadow-sm dark:bg-white/10' : 'text-stone-500 dark:text-stone-400',
              )}
              onClick={() => onViewChange('grid')}
              type="button"
            >
              <Grid3X3 className="h-3.5 w-3.5" />
            </button>
            <button
              aria-label="列表视图"
              aria-pressed={view === 'list'}
              className={cn(
                'grid h-11 w-11 place-items-center rounded-full transition lg:h-8 lg:w-8',
                view === 'list' ? 'bg-white text-accent shadow-sm dark:bg-white/10' : 'text-stone-500 dark:text-stone-400',
              )}
              onClick={() => onViewChange('list')}
              type="button"
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
