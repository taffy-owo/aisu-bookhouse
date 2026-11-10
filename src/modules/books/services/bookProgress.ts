import { formatReadingProgressPercent, normalizeReadingProgress } from '../../../shared/utils/readingProgress';
import type { Book } from '../types/book';

export function hasBookReadingHistory(book: Pick<Book, 'progressPercent' | 'lastReadAt'>): boolean {
  return book.progressPercent > 0 || Boolean(book.lastReadAt);
}

export type BookProgressTone = 'finished' | 'inProgress' | 'unread';

export interface BookProgressLabel {
  label: string;
  tone: BookProgressTone;
}

export function getBookProgressLabel(value: number, lastReadAt?: string): BookProgressLabel {
  const normalizedValue = normalizeReadingProgress(value);

  if (normalizedValue >= 100) {
    return { label: '已读', tone: 'finished' };
  }

  if (normalizedValue <= 0) {
    if (lastReadAt) return { label: '阅读 <1%', tone: 'inProgress' };
    return { label: '未读', tone: 'unread' };
  }

  return {
    label: `阅读 ${formatReadingProgressPercent(normalizedValue)}`,
    tone: 'inProgress',
  };
}
