import { formatReadingProgressPercent } from '../../../shared/utils/readingProgress';
import { useReaderBarViewport } from '../hooks/useReaderBarViewport';
import type { ReaderTheme } from '../types/reader';
import { ProgressSyncIndicator } from './ProgressSyncIndicator';

export function ReaderReadingStatus({ bookId, isHidden, progressPercent, theme }: {
  bookId: string;
  isHidden: boolean;
  progressPercent: number;
  theme: ReaderTheme;
}) {
  const barRef = useReaderBarViewport('bottom');
  const percent = formatReadingProgressPercent(progressPercent);
  return <div ref={barRef} aria-label="阅读状态" aria-hidden={isHidden}
    className={`reader-reading-status reader-theme-${theme}`}>
    <ProgressSyncIndicator bookId={bookId} inline />
    <span aria-label={`全书阅读进度 ${percent}`} className="reader-reading-status-percent">{percent}</span>
  </div>;
}
