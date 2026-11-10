import { ArrowDown, ChevronLeft } from 'lucide-react';

interface ReaderChapterNavigationProps {
  chapterIndex: number;
  chapterCount: number;
  placement?: 'start' | 'end';
  disabled?: boolean;
  nextTitle?: string;
  previousTitle?: string;
  onNext: () => void;
  onPrevious: () => void;
}

export function ReaderChapterNavigation({ chapterIndex, chapterCount, placement = 'end', disabled = false, nextTitle, previousTitle, onNext, onPrevious }: ReaderChapterNavigationProps) {
  const isLastChapter = chapterIndex >= chapterCount;

  if (placement === 'start') {
    if (chapterIndex <= 1) return null;
    return (
      <nav aria-label="章节开头导航" className="reader-chapter-start">
        <button disabled={disabled} onClick={onPrevious} type="button">
          <ChevronLeft aria-hidden /><span>上一话</span><span className="reader-chapter-start-title">{previousTitle}</span>
        </button>
      </nav>
    );
  }

  return (
    <nav aria-label="章节末尾导航" className="reader-chapter-nav reader-chapter-nav-end">
      {isLastChapter ? (
        <div className="reader-chapter-complete"><span>本书已读至最后一话</span><p>共 {chapterCount} 话 · 可从目录回看章节</p></div>
      ) : (
        <button className="reader-next-chapter" disabled={disabled} onClick={onNext} type="button">
          <span className="reader-next-label">下一话</span>
          <strong>{nextTitle || `第 ${chapterIndex + 1} 话`}</strong>
          <span className="reader-next-icon"><ArrowDown aria-hidden /></span>
        </button>
      )}
    </nav>
  );
}
