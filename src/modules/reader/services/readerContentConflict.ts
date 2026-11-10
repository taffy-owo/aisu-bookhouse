import { ApiError, getAccountScope } from '../../../shared/api';

export function readerContentConflictEvent(bookId: string, scope = getAccountScope()): string {
  return `aisu:reader-content-conflict:${JSON.stringify([scope, bookId])}`;
}

export function notifyReaderContentConflict(bookId: string, error: unknown, scope: string, signal?: AbortSignal): boolean {
  if (!bookId || !(error instanceof ApiError) || error.status !== 409 || signal?.aborted || scope !== getAccountScope() || typeof window === 'undefined') return false;
  window.dispatchEvent(new Event(readerContentConflictEvent(bookId, scope)));
  return true;
}
