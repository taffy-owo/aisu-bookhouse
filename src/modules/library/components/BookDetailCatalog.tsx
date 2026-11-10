import { hasBookReadingHistory } from '../../books/services/bookProgress';
import { LoaderCircle, MessageCircle, Pencil } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { getReaderRouteForBook } from '../../books';
import type { Book } from '../../books';
import { PublicCommentsPanel } from '../../comments/PublicCommentsPanel';
import type { ReaderResource } from '../../reader/types/reader';
import { cn } from '../../../shared/utils/cn';
import { formatReadingProgressPercent } from '../../../shared/utils/readingProgress';

interface BookDetailCatalogProps {
  activeChapterIndex?: number | null;
  activePageIndex?: number | null;
  book: Book;
  commentsVisible?: boolean;
  editableChapterIndexes?: ReadonlySet<number>;
  editingChapterIndex?: number | null;
  isPublicBook?: boolean;
  onCommentsVisibilityChange?: (isVisible: boolean) => void;
  onEditChapter?: (chapterIndex: number) => void;
  progressPercent: number;
  readerResource: ReaderResource | null;
}

export function BookDetailCatalog({ activeChapterIndex, activePageIndex, book, commentsVisible = false, editableChapterIndexes, editingChapterIndex, isPublicBook = false, onCommentsVisibilityChange, onEditChapter, progressPercent, readerResource }: BookDetailCatalogProps) {
  const navigationState = createCollectionLinkState(useLocation());
  const [openCommentChapterIndex, setOpenCommentChapterIndex] = useState<number | null>(null);
  const [visitedCommentChapters, setVisitedCommentChapters] = useState<ReadonlySet<number>>(new Set());
  const commentRegionId = useId();
  const toc = readerResource && 'toc' in readerResource ? readerResource.toc : [];
  const hasNestedToc = toc.some((chapter) => (chapter.level ?? 1) > 1);
  const pages = readerResource && 'pages' in readerResource ? readerResource.pages : [];

  if (toc.length) {
    return (
      <div className="mt-6 divide-y divide-stone-100 dark:divide-stone-800">
        {toc.map((chapter, chapterPosition) => {
          const isActive = chapter.index === activeChapterIndex;
          const isEditable = editableChapterIndexes?.has(chapter.index) && onEditChapter;
          const previousSectionTitle = chapterPosition > 0 ? toc[chapterPosition - 1]?.sectionTitle : undefined;
          const shouldShowSection = Boolean(chapter.sectionTitle && chapter.sectionTitle !== previousSectionTitle);

          return (
            <div className="group relative py-1" key={`${chapter.index}-${chapter.title}`}>
              {shouldShowSection && (
                <p
                  className="px-1 pb-2 pt-5 text-xs font-semibold text-stone-400 dark:text-stone-500"
                  style={{ paddingLeft: `${Math.min(3, Math.max(0, (chapter.sectionLevel ?? 1) - 1)) * 14 + 4}px` }}
                >
                  {chapter.sectionTitle}
                </p>
              )}
              <div className={cn('relative -mx-2 flex items-center transition', isActive ? activeCatalogItemClassName : catalogItemClassName)}>
                <Link
                  aria-current={isActive ? 'page' : undefined}
                  className={cn('relative flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left', isActive && 'pl-4')}
                  state={navigationState} to={`${getReaderRouteForBook(book)}?chapter=${chapter.index}`}
                >
                  <span
                    className={cn('min-w-0 flex-1 break-words [overflow-wrap:anywhere]', hasNestedToc && (chapter.level ?? 1) === 1 && 'font-semibold')}
                    style={{ paddingLeft: hasNestedToc ? `${Math.min(3, Math.max(0, (chapter.level ?? 1) - 1)) * 14}px` : undefined }}
                  >
                    {chapter.title}
                  </span>
                  {isActive && <span className="shrink-0 whitespace-nowrap rounded-full border border-accent/15 bg-white/70 px-2 py-0.5 text-[11px] font-medium text-stone-500 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-night-soft">{progressPercent >= 100 ? '已读完' : progressPercent > 0 || hasBookReadingHistory(book) ? '读到这里' : '阅读起点'} · {formatReadingProgressPercent(progressPercent)}</span>}
                </Link>
                {isEditable && (
                  <button
                    aria-label={`编辑${chapter.title}`}
                    className="mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-stone-500 transition hover:bg-white hover:text-accent disabled:opacity-60 dark:text-stone-400 dark:hover:bg-white/[0.08] dark:hover:text-night-ink sm:px-2.5 lg:min-h-9 lg:min-w-9"
                    disabled={editingChapterIndex !== null && editingChapterIndex !== undefined}
                    onClick={() => onEditChapter(chapter.index)}
                    title="编辑并整理这一章"
                    type="button"
                  >
                    {editingChapterIndex === chapter.index ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">编辑</span>
                  </button>
                )}
              </div>
              {isPublicBook && onCommentsVisibilityChange && (
                <>
                  <div className="flex justify-end px-1 pb-2">
                    <button
                      aria-expanded={openCommentChapterIndex === chapter.index && commentsVisible}
                      aria-controls={visitedCommentChapters.has(chapter.index) ? `${commentRegionId}-${chapter.index}` : undefined}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-xl px-2 text-xs text-stone-500 transition hover:bg-stone-100 hover:text-accent dark:text-stone-400 dark:hover:bg-white/[0.05]"
                      onClick={() => {
                        const shouldOpen = openCommentChapterIndex !== chapter.index || !commentsVisible;
                        if (shouldOpen && !commentsVisible) {
                          onCommentsVisibilityChange(true);
                        }
                        setVisitedCommentChapters((current) => new Set([...current, chapter.index]));
                        setOpenCommentChapterIndex(shouldOpen ? chapter.index : null);
                      }}
                      type="button"
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                      {openCommentChapterIndex === chapter.index && commentsVisible ? '收起评论' : '分卷评论'}
                    </button>
                  </div>
                  {visitedCommentChapters.has(chapter.index) && (
                    <div hidden={openCommentChapterIndex !== chapter.index} id={`${commentRegionId}-${chapter.index}`}>
                      <PublicCommentsPanel
                        bookId={book.id}
                        isVisible={commentsVisible && openCommentChapterIndex === chapter.index}
                        onVisibilityChange={onCommentsVisibilityChange}
                        targetIndex={chapter.index}
                        targetLabel={`${chapter.title} 评论`}
                        targetType="volume"
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (pages.length) {
    return (
      <div className="mt-6">
        <div className="mb-4 flex items-center justify-between text-sm text-stone-500 dark:text-stone-400">
          <span>图片页目录</span>
          <span>共 {pages.length} 页</span>
        </div>
        <div className="grid max-h-[420px] grid-cols-4 gap-2 overflow-y-auto overflow-x-hidden pr-1 reader-scrollbar sm:grid-cols-6 md:grid-cols-8">
          {pages.map((page) => (
            <Link
              aria-current={page.index === activePageIndex ? 'page' : undefined}
              className={page.index === activePageIndex ? activePageItemClassName : pageItemClassName}
              key={page.index}
              state={navigationState} to={`${getReaderRouteForBook(book)}?page=${page.index}`}
            >
              {page.index}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const emptyMessage = readerResource?.readerType === 'pdf' ? 'PDF 目录和页码请在阅读器中查看。'
    : readerResource?.readerType === 'unsupported' ? '当前格式暂不支持在线目录。' : '这本书还没有可显示的在线目录。';
  return <div className="py-8 text-sm text-stone-500 dark:text-stone-400">{emptyMessage}</div>;
}

const catalogItemClassName = 'hover:bg-stone-100/70 hover:text-stone-950 dark:hover:bg-white/[0.04] dark:hover:text-night-ink';
const activeCatalogItemClassName = 'border-l-2 border-accent/70 bg-accent/[0.055] text-stone-950 dark:bg-white/[0.055] dark:text-night-ink';
const pageItemClassName = 'grid h-11 place-items-center rounded-lg border border-stone-200 text-sm transition hover:border-accent hover:text-accent dark:border-white/10';
const activePageItemClassName = 'grid h-11 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-sm font-medium text-accent shadow-[0_10px_24px_rgba(243,111,108,0.12)] dark:bg-accent/15';
