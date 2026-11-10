import { Bookmark, ChevronLeft, List, Pencil, Type } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getBookDetailPath } from '../../../config/routes';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { cn } from '../../../shared/utils/cn';
import type { Book } from '../../books';
import { useReaderFavorite } from '../hooks/useReaderFavorite';
import type { ReaderEditionSwitch } from '../hooks/useReaderEditionSwitch';
import { useReaderBarViewport } from '../hooks/useReaderBarViewport';

interface ReaderTopBarProps {
  book: Book;
  chapterTitle?: string;
  contentCheck?: { isChecking: boolean; error: string | null; onRetry: () => void };
  editionSwitch?: ReaderEditionSwitch;
  isDark?: boolean;
  isVisible: boolean;
  isEditLoading?: boolean;
  onEditChapter?: () => void;
  onOpenToc?: () => void;
  onOpenSettings?: () => void;
  chapterRefresh?: ReaderEditionSwitch;
  isDocked?: boolean;
  isCatalogOpen?: boolean;
}

export function ReaderTopBar({ book, chapterTitle, contentCheck, editionSwitch, isDark = false, isEditLoading = false, isVisible, onEditChapter, onOpenToc, onOpenSettings, chapterRefresh, isDocked = false, isCatalogOpen }: ReaderTopBarProps) {
  const barRef = useReaderBarViewport('top');
  const { controller: favoriteController, state: favoriteState } = useReaderFavorite(book);
  const navigate = useNavigate();
  const navigationState = createCollectionLinkState(useLocation());
  const recovery = !chapterRefresh && (contentCheck?.isChecking || contentCheck?.error) ? contentCheck : undefined;
  const titleAction = editionSwitch?.onLoad ?? chapterRefresh?.onLoad ?? recovery?.onRetry;
  const isChecking = Boolean(editionSwitch?.isLoading || chapterRefresh?.isLoading || recovery?.isChecking);
  const actionLabel = editionSwitch ? '阅读文件已更新，打开新版阅读器' : chapterRefresh ? '本话已更新，加载新版正文' : isChecking ? '正在检查正文更新' : '检查更新失败，重试检查正文';
  const actionText = editionSwitch ? editionSwitch.isLoading ? '正在打开新版…' : editionSwitch.error ? '新版打开失败 · 重试' : '阅读文件已更新 · 打开新版' : chapterRefresh ? chapterRefresh.isLoading ? '正在加载新版…' : chapterRefresh.error ? '新版加载失败 · 重试' : '本话已更新 · 加载新版' : isChecking ? '正在检查更新…' : '检查更新失败 · 重试';

  return (
    <div
      ref={barRef}
      aria-hidden={!isVisible}
      className={cn(
        'reader-chrome reader-chrome-top reader-safe-top fixed left-0 right-0 top-0 z-50 px-3 pb-5 transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] sm:px-5',
        isVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-3 opacity-0',
        isDark ? 'text-[color:var(--reader-ink)]' : 'text-stone-700',
        isDocked && 'reader-chrome-docked',
      )}
      inert={!isVisible}
    >
      {favoriteState.message && <div role="status" className="reader-inline-message absolute right-4 top-[calc(3.5rem+env(safe-area-inset-top))] px-3 py-2 text-xs">{favoriteState.message}</div>}
      <div className="reader-topbar-content mx-auto grid max-w-6xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <button aria-label="返回图书详情" className="reader-chrome-action inline-flex min-h-10 w-fit items-center gap-1.5 px-2 text-sm" onClick={() => navigate(getBookDetailPath(book.id), { state: navigationState })} type="button">
          <ChevronLeft className="h-4 w-4" />
          <span className="hidden sm:inline">返回</span>
        </button>
        <div className={cn('reader-chrome-title min-w-0 max-w-[46vw] text-center text-xs sm:max-w-[54vw] sm:text-sm', !titleAction && 'truncate')}>
          {titleAction ? (
            <button aria-label={actionLabel} aria-busy={isChecking} disabled={isChecking} title={editionSwitch?.error ?? chapterRefresh?.error ?? recovery?.error ?? undefined} className="-my-0.5 flex min-h-11 w-full flex-col justify-center text-center" onClick={titleAction} type="button">
              <span className="block truncate">{book.title}</span>
              <span className="reader-top-chapter block truncate text-[color:var(--reader-accent)]" aria-live="polite">{actionText}</span>
            </button>
          ) : <><span className="block truncate">{book.title}</span><span className="reader-top-chapter block truncate">{chapterTitle ?? book.currentChapter}</span></> }
        </div>
        <div className="reader-topbar-actions flex min-w-0 flex-wrap items-center justify-end gap-1">
          {onEditChapter && (
            <button
              aria-label="编辑本章"
              className="reader-chrome-action grid h-10 w-10 place-items-center disabled:cursor-wait disabled:opacity-40"
              disabled={isEditLoading}
              onClick={onEditChapter}
              title="编辑本章"
              type="button"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {onOpenSettings && (
            <button aria-label="打开阅读设置" title="阅读外观" className="reader-chrome-action grid h-10 w-10 place-items-center" onClick={onOpenSettings} type="button"><Type className="h-5 w-5" /></button>
          )}
          {onOpenToc && (
            <button aria-label="打开目录" aria-expanded={isCatalogOpen} aria-controls={isCatalogOpen === undefined ? undefined : 'reader-chapter-catalog'} className="reader-chrome-action inline-flex h-10 items-center gap-1.5 px-2 text-sm" onClick={onOpenToc} type="button">
              <List className="h-4 w-4" />
              <span className="hidden sm:inline">目录</span>
            </button>
          )}
          <button
            aria-label={favoriteState.favorite ? '取消收藏' : '加入收藏'}
            className="reader-chrome-action grid h-10 w-10 place-items-center disabled:cursor-not-allowed disabled:opacity-35"
            disabled={!book.isOwned || favoriteState.isSaving}
            onClick={() => void favoriteController.toggle()}
            type="button"
          >
            <Bookmark className={favoriteState.favorite ? 'h-4 w-4 fill-current text-accent' : 'h-4 w-4'} />
          </button>
        </div>
      </div>
    </div>
  );
}
