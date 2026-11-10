import type { Book } from '../../books';

export function createReaderDownloadController(
  bookId: string,
  download: (book: Book, signal: AbortSignal) => Promise<void>,
  readScope: () => string,
) {
  const owner = readScope();
  const empty = { error: '', isPreparing: false };
  let state = empty;
  let pending: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => { state = next; listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => owner === readScope() ? state : empty,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset: () => { pending?.abort(); pending = null; publish(empty); },
    run: async (book: Book) => {
      if (pending || book.id !== bookId || owner !== readScope()) return;
      const request = new AbortController();
      pending = request;
      publish({ error: '', isPreparing: true });
      try {
        await download(book, request.signal);
      } catch (error) {
        if (pending === request && owner === readScope() && !request.signal.aborted) {
          publish({ error: error instanceof Error ? error.message : '下载准备失败，请重试', isPreparing: true });
        }
      } finally {
        if (pending === request) {
          pending = null;
          publish(owner === readScope() ? { ...state, isPreparing: false } : empty);
        }
      }
    },
  };
}
