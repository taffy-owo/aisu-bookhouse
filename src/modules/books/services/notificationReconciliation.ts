import type { TranslationJobNotifications, WholeBookTranslationJob } from '../../uploads/services/wholeBookTranslationService';
import type { SourceUpdateNotifications } from './bookService';

export function removeAcknowledgedSourceUpdate(current: SourceUpdateNotifications, bookId: string): SourceUpdateNotifications {
  const removed = current.items.find((book) => book.id === bookId);
  if (!removed) return current;
  return {
    bookCount: Math.max(0, current.bookCount - 1),
    episodeCount: Math.max(0, current.episodeCount - (removed.sourceUpdateCount ?? 0)),
    items: current.items.filter((book) => book.id !== bookId),
  };
}

const active = (job?: WholeBookTranslationJob | null) => Number(Boolean(job && ['processing', 'queued', 'waiting_quota'].includes(job.status)));
const unread = (job?: WholeBookTranslationJob | null) => Number(Boolean(job && !job.acknowledged && ['ready', 'review', 'failed'].includes(job.status)));

/** Apply the confirmed mutation without discarding counts outside the visible list. */
export function reconcileTranslationNotification(current: TranslationJobNotifications, jobId: string, updated?: WholeBookTranslationJob): TranslationJobNotifications {
  const previous = current.items.find((job) => job.id === jobId);
  const visible = updated && (active(updated) || !updated.acknowledged) ? updated : null;
  const items = current.items.filter((job) => job.id !== jobId);
  if (visible) items.unshift(visible);
  return {
    active_count: Math.max(0, current.active_count - active(previous) + active(visible)),
    unread_count: Math.max(0, current.unread_count - unread(previous) + unread(visible)),
    items,
  };
}
