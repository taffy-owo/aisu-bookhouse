import { getAccountScope } from '../../../shared/api';

export type PendingReplacement = { taskId: string; keepProgress: boolean };
const pending = new Map<string, PendingReplacement>();
const keyFor = (bookId: string) => `aisu-bookhouse:replacement:${encodeURIComponent(getAccountScope())}:${encodeURIComponent(bookId)}`;

export function readPendingReplacement(bookId: string): PendingReplacement | null {
  const key = keyFor(bookId);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw) {
      const value = JSON.parse(raw) as Partial<PendingReplacement> | null;
      if (value && typeof value.taskId === 'string' && value.taskId.trim() && typeof value.keepProgress === 'boolean') {
        const attempt = { taskId: value.taskId, keepProgress: value.keepProgress };
        pending.set(key, attempt);
        return attempt;
      }
    }
  } catch { /* Navigation recovery still works when browser storage is blocked. */ }
  return pending.get(key) ?? null;
}

export function savePendingReplacement(bookId: string, attempt: PendingReplacement): void {
  const key = keyFor(bookId);
  pending.set(key, attempt);
  try { window.sessionStorage.setItem(key, JSON.stringify(attempt)); } catch { /* Keep the memory copy. */ }
}

export function clearPendingReplacement(bookId: string): void {
  const key = keyFor(bookId);
  pending.delete(key);
  try { window.sessionStorage.removeItem(key); } catch { /* The memory copy was removed. */ }
}
