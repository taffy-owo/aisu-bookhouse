import { BookMarked, ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { cn } from '../../../shared/utils/cn';

interface MangaPageNavigatorProps {
  currentPageIndex: number;
  imageScale: number;
  isVisible: boolean;
  onNext?: () => void;
  onOpenMarks?: () => void;
  onPrevious?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  pageCount: number;
  progressPercent: number;
}

export function MangaPageNavigator({ currentPageIndex, imageScale, isVisible, onNext, onOpenMarks, onPrevious, onZoomIn, onZoomOut, onZoomReset, pageCount, progressPercent }: MangaPageNavigatorProps) {
  return (
    <div
      aria-hidden={!isVisible}
      data-reader-controls
      className={cn(
        'manga-page-navigator fixed bottom-[calc(44px+env(safe-area-inset-bottom))] left-0 right-0 z-50 border-t border-white/10 bg-[#050505]/[0.92] px-3 py-3 text-[color:var(--reader-ink)] backdrop-blur-2xl transition-transform duration-300 sm:px-4 sm:py-4',
        isVisible ? 'translate-y-0' : 'translate-y-[calc(100%+44px+env(safe-area-inset-bottom))]',
      )}
      inert={!isVisible}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 text-xs sm:flex-row sm:items-center sm:gap-4 sm:text-sm">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:min-w-0 sm:flex-1 sm:gap-4">
          <button
            aria-label="上一页"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-xl px-2 hover:bg-white/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-35 sm:px-3"
            aria-disabled={currentPageIndex <= 1}
            onClick={() => { if (currentPageIndex > 1) onPrevious?.(); }}
            type="button"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">上一页</span>
          </button>
          <div aria-label="漫画进度" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100} className="h-1 rounded-full bg-white/15">
            <div className="h-full rounded-full bg-[color:var(--reader-accent)]" style={{ width: `${progressPercent}%` }} />
          </div>
          <button
            aria-label="下一页"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-xl px-2 hover:bg-white/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-35 sm:px-3"
            aria-disabled={currentPageIndex >= pageCount}
            onClick={() => { if (currentPageIndex < pageCount) onNext?.(); }}
            type="button"
          >
            <span className="hidden sm:inline">下一页</span>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:w-auto">
          <span className="shrink-0 tabular-nums">{currentPageIndex} / {pageCount}</span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button aria-label="打开书签与备注" className="grid min-h-[44px] min-w-[44px] place-items-center rounded-2xl hover:bg-white/10" onClick={onOpenMarks} type="button">
              <BookMarked className="h-4 w-4" />
            </button>
            <div className="flex items-center rounded-2xl border border-white/10 bg-white/[0.04]">
              <button aria-label="缩小漫画" className="grid min-h-[44px] min-w-[44px] place-items-center hover:bg-white/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-35" aria-disabled={imageScale <= 0.75} onClick={() => { if (imageScale > 0.75) onZoomOut?.(); }} type="button">
                <Minus className="h-4 w-4" />
              </button>
              <button aria-label="重置漫画缩放" className="min-h-[44px] min-w-14 px-2 text-xs tabular-nums hover:bg-white/10" onClick={onZoomReset} type="button">
                {Math.round(imageScale * 100)}%
              </button>
              <button aria-label="放大漫画" className="grid min-h-[44px] min-w-[44px] place-items-center hover:bg-white/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-35" aria-disabled={imageScale >= 3} onClick={() => { if (imageScale < 3) onZoomIn?.(); }} type="button">
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
