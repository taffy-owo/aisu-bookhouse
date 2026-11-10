import { BookMarked, ChevronLeft, ChevronRight, Headphones, Languages, Search, Settings } from 'lucide-react';
import type { ReaderTheme } from '../types/reader';
import { cn } from '../../../shared/utils/cn';
import { formatReadingProgressPercent, normalizeReadingProgress } from '../../../shared/utils/readingProgress';
import { useReaderBarViewport } from '../hooks/useReaderBarViewport';

interface ReaderBottomBarProps {
  chapterCount: number;
  chineseScript?: 'original' | 'simplified';
  currentChapterIndex: number;
  /** Current page within the chapter (paged mode only). */
  currentPage?: number;
  hidePageNavigation?: boolean;
  isDark?: boolean;
  isNextDisabled?: boolean;
  isPreviousDisabled?: boolean;
  isVisible: boolean;
  onNext?: () => void;
  onOpenFind?: () => void;
  onOpenMarks?: () => void;
  onOpenSettings?: () => void;
  onOpenJapaneseTools?: () => void;
  onOpenAudiobook?: () => void;
  onPrevious?: () => void;
  onToggleChineseScript?: () => void;
  /** Total pages within the chapter (paged mode only). */
  pageCount?: number;
  progressPercent: number;
  readingMetaLabel?: string;
  theme?: ReaderTheme;
}

export function ReaderBottomBar({
  chapterCount,
  chineseScript = 'original',
  currentChapterIndex,
  currentPage,
  hidePageNavigation = false,
  isNextDisabled = false,
  isPreviousDisabled = false,
  isVisible,
  onNext,
  onOpenFind,
  onOpenMarks,
  onOpenSettings,
  onOpenJapaneseTools,
  onOpenAudiobook,
  onPrevious,
  onToggleChineseScript,
  pageCount,
  progressPercent,
  readingMetaLabel,
  theme = 'paper',
}: ReaderBottomBarProps) {
  const barRef = useReaderBarViewport('bottom');
  const clampedProgress = normalizeReadingProgress(progressPercent);
  const displayProgress = formatReadingProgressPercent(clampedProgress);
  const pageLabel = currentPage && pageCount ? `${currentPage}/${pageCount} 页` : null;
  const navigationUnit = pageLabel ? '页' : '章';

  return (
    <div
      ref={barRef}
      aria-hidden={!isVisible}
      className={cn(
        `reader-chrome reader-chrome-bottom reader-bottom-bar reader-theme-${theme}`,
        'reader-safe-bottom fixed bottom-0 left-0 right-0 z-50 px-3 pt-7 transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] sm:px-5 sm:pt-8',
        isVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0',
      )}
      inert={!isVisible}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:gap-3">
        <div className={cn('grid items-center gap-2 text-xs sm:gap-4', hidePageNavigation ? 'grid-cols-1' : 'grid-cols-[auto_minmax(0,1fr)_auto]')}>
          {!hidePageNavigation && <button
            aria-label={`上一${navigationUnit}`}
            className="reader-chrome-action reader-bottom-action inline-flex h-10 min-w-10 items-center justify-center gap-1.5 px-2 py-1.5 disabled:cursor-not-allowed disabled:opacity-35 sm:px-3"
            disabled={isPreviousDisabled}
            onClick={onPrevious}
            type="button"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">上一{navigationUnit}</span>
          </button>}
          <div className="min-w-0">
            <div className="reader-bottom-meta mb-1.5 flex items-center justify-center gap-2 text-[11px] tabular-nums sm:hidden">
              <span className="inline-block w-[4ch] text-right">{displayProgress}</span>
              <span className="inline-block min-w-[7ch] text-left">
                {currentChapterIndex} / {chapterCount}
              </span>
              {pageLabel && <span className="inline-block min-w-[6ch] text-left">{pageLabel}</span>}
            </div>
            <div aria-label={`阅读进度 ${displayProgress}`} className="reader-bottom-progress-track relative h-[2px]">
              <div className="reader-bottom-progress-fill h-full min-w-[4px] transition-[width] duration-500" style={{ width: `${clampedProgress}%` }} />
            </div>
          </div>
          {!hidePageNavigation && <button
            aria-label={`下一${navigationUnit}`}
            className="reader-chrome-action reader-bottom-action inline-flex h-10 min-w-10 items-center justify-center gap-1.5 px-2 py-1.5 disabled:cursor-not-allowed disabled:opacity-35 sm:px-3"
            disabled={isNextDisabled}
            onClick={onNext}
            type="button"
          >
            <span className="hidden sm:inline">下一{navigationUnit}</span>
            <ChevronRight className="h-4 w-4" />
          </button>}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs sm:gap-3">
          <div className="reader-bottom-tools -mx-1 flex min-w-0 flex-1 items-center justify-between gap-1 overflow-x-auto px-1 sm:mx-0 sm:justify-start sm:gap-2 sm:overflow-visible sm:px-0">
            <button aria-label="打开书签与备注" title="书签与备注" className="reader-chrome-action reader-bottom-action inline-flex min-h-10 items-center gap-1.5 px-3 py-2 sm:gap-2" onClick={onOpenMarks} type="button">
              <BookMarked className="h-4 w-4" />
              <span className="reader-bottom-tool-label hidden sm:inline">书签</span>
            </button>
            <button aria-label="打开当前章查找" title="查找当前章" className="reader-chrome-action reader-bottom-action inline-flex min-h-10 items-center gap-1.5 px-3 py-2 sm:gap-2" onClick={onOpenFind} type="button">
              <Search className="h-4 w-4" />
              <span className="reader-bottom-tool-label hidden sm:inline">查找</span>
            </button>
            {onOpenAudiobook && (
              <button aria-label="打开听书" title="听书" className="reader-chrome-action reader-bottom-action inline-flex min-h-10 items-center gap-1.5 px-3 py-2 sm:gap-2" onClick={onOpenAudiobook} type="button">
                <Headphones className="h-4 w-4" />
                <span className="reader-bottom-tool-label hidden sm:inline">听书</span>
              </button>
            )}
            {onToggleChineseScript && (
              <button
                aria-label={chineseScript === 'simplified' ? '恢复繁体原文' : '将繁体转换为简体'}
                aria-pressed={chineseScript === 'simplified'}
                className={cn(
                  'reader-chrome-action reader-bottom-action inline-flex min-h-10 items-center gap-1.5 px-3 py-2 sm:gap-2',
                  chineseScript === 'simplified' && 'reader-bottom-japanese',
                )}
                onClick={onToggleChineseScript}
                title={chineseScript === 'simplified' ? '恢复原文' : '繁体转简体'}
                type="button"
              >
                <Languages className="h-4 w-4" />
                <span>{chineseScript === 'simplified' ? '原文' : '转简'}</span>
              </button>
            )}
            <button aria-label="打开阅读设置" title="阅读设置" className="reader-chrome-action reader-bottom-action inline-flex min-h-10 items-center gap-1.5 px-3 py-2 sm:gap-2" onClick={onOpenSettings} type="button">
              <Settings className="h-4 w-4" />
              <span className="reader-bottom-tool-label hidden sm:inline">设置</span>
            </button>
            {onOpenJapaneseTools && (
              <button
                aria-label="打开日文阅读设置"
                title="日文阅读设置"
                className="reader-chrome-action reader-bottom-japanese inline-flex min-h-10 items-center gap-1.5 px-3 py-2 sm:gap-2"
                onClick={onOpenJapaneseTools}
                type="button"
              >
                <Languages className="h-4 w-4" />
                <span>日文</span>
              </button>
            )}
          </div>
          <div className="reader-bottom-meta reader-bottom-details hidden min-w-0 flex-1 items-center justify-end gap-1.5 text-right tabular-nums sm:flex sm:gap-3">
            {readingMetaLabel && <span className="reader-bottom-estimate hidden min-w-0 max-w-[20rem] truncate md:inline lg:max-w-[24rem]">{readingMetaLabel}</span>}
            <span className="reader-bottom-theme hidden w-10 shrink-0 text-left sm:inline">{themeLabel[theme]}</span>
            <span className="inline-block w-[4ch] shrink-0 text-right">{displayProgress}</span>
            <span className="inline-block min-w-[7ch] shrink-0 text-right">
              {currentChapterIndex} / {chapterCount}
            </span>
            {pageLabel && <span className="inline-block min-w-[6ch] shrink-0 text-right">{pageLabel}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

const themeLabel: Record<ReaderTheme, string> = {
  dark: '夜间',
  green: '护眼',
  paper: '纸书',
  white: '净白',
};
