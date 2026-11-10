import { useEffect, useState } from 'react';
import type { ReaderResource, ReadingProgress } from '../../reader/types/reader';
import { resolveInitialChapterProgress } from '../../reader/services/chapterPositionHistory';
import { resolveInitialMediaProgress } from '../../reader/services/mediaReadingProgress';
import { getPendingReadingProgress, subscribeReadingProgressSync } from '../../reader/services/readingProgressSync';

/** Keep an observed local position while its acknowledgement refreshes the detail page. */
export function useBookReadingProgress(bookId: string, sessionId: string | undefined, resource: ReaderResource | null, server: ReadingProgress | null): ReadingProgress | null {
  const key = JSON.stringify([sessionId, bookId]);
  const [observed, setObserved] = useState<{ key: string; progress: ReadingProgress | null }>({ key, progress: null });

  useEffect(() => {
    const update = () => {
      const pending = getPendingReadingProgress(bookId);
      setObserved((current) => {
        // Removing a successfully synced queue entry must not briefly restore
        // the old server percentage while the resulting GET is still pending.
        if (current.key === key && (!pending || JSON.stringify(current.progress) === JSON.stringify(pending))) return current;
        return { key, progress: pending };
      });
    };
    update();
    return subscribeReadingProgressSync(update);
  }, [bookId, key]);

  if (!resource || (server && server.bookId !== bookId)) return server;
  const base = server ?? { bookId, readerType: resource.readerType, progressPercent: 0, updatedAt: '' };
  const pending = observed.key === key ? observed.progress : null;
  const resolved = resolveInitialChapterProgress(resource, resolveInitialMediaProgress(resource, base, pending), pending);
  return resolved === base ? server : resolved;
}
