import { getApiServerTime } from '../../../shared/api/serverClock';
import type { ReadingProgress } from '../types/reader';

const ENTRY_PREFIX = 'aisu-bookhouse:progress-queue-v2:';
type StoredEntry = { key: string; progress: ReadingProgress; order: number };
let latestOrder = 0;

export function progressStoragePrefix(scope: string): string {
  return `${ENTRY_PREFIX}${encodeURIComponent(scope)}:`;
}

export function getProgressSignature(progress: ReadingProgress): string {
  return JSON.stringify({
    bookId: progress.bookId,
    positionKey: progress.positionKey ?? null,
    contentVersion: progress.contentVersion ?? null,
    chapterHref: progress.chapterHref ?? null,
    chapterIndex: progress.chapterIndex ?? null,
    epubCfi: progress.epubCfi ?? null,
    imageIndex: progress.imageIndex ?? null,
    pageNumber: progress.pageNumber ?? null,
    progressPercent: progress.progressPercent,
    readerType: progress.readerType ?? null,
    updatedAt: progress.updatedAt,
  });
}

/** Reading time wins across tabs; a corrected edition may retain that time. */
export function compareProgressReadTime(left: ReadingProgress, right: ReadingProgress): number {
  const usableTime = (progress: ReadingProgress) => {
    const time = Date.parse(progress.updatedAt);
    return Number.isFinite(time) && time <= getApiServerTime() + 300_000 ? time : 0;
  };
  return usableTime(left) - usableTime(right);
}

export function isProgressAcknowledged(progress: ReadingProgress, acknowledged: ReadingProgress): boolean {
  return getProgressSignature(progress) === getProgressSignature(acknowledged)
    || compareProgressReadTime(progress, acknowledged) < 0;
}

function browserStorage(): Storage {
  if (typeof window === 'undefined') throw new Error('Storage unavailable');
  return window.localStorage;
}

function entries(scope: string): StoredEntry[] {
  const storage = browserStorage(), prefix = progressStoragePrefix(scope);
  // Snapshot keys before touching storage. Every entry is immutable, so a
  // concurrent writer cannot change the meaning of a key we later remove.
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => !!key?.startsWith(prefix));
  const result: StoredEntry[] = [];
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw) as { progress?: ReadingProgress; order?: number };
      if (!entry.progress?.bookId || typeof entry.progress.updatedAt !== 'string'
        || !Number.isSafeInteger(entry.order) || entry.order! < 0) continue;
      latestOrder = Math.max(latestOrder, entry.order!);
      result.push({ key, progress: entry.progress, order: entry.order! });
    } catch { /* An invalid row must not hide other pending books. */ }
  }
  return result;
}

function createEntry(scope: string, progress: ReadingProgress, order = Math.max(Date.now(), latestOrder + 1)): void {
  latestOrder = Math.max(latestOrder, order);
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  browserStorage().setItem(`${progressStoragePrefix(scope)}${id}`, JSON.stringify({ progress, order }));
}

function migrateLegacy(scope: string): void {
  const storage = browserStorage(), raw = storage.getItem(scope);
  if (!raw) return;
  let legacy: unknown;
  try { legacy = JSON.parse(raw); } catch { return; }
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return;
  const known = new Set(entries(scope).map((entry) => getProgressSignature(entry.progress)));
  for (const [bookId, value] of Object.entries(legacy)) {
    const progress = value as ReadingProgress | null;
    if (!progress || progress.bookId !== bookId || typeof progress.updatedAt !== 'string') continue;
    if (!known.has(getProgressSignature(progress))) createEntry(scope, progress, 0);
  }
  // Preserve the old map if another page changed it during migration.
  if (storage.getItem(scope) === raw) storage.removeItem(scope);
}

export function readStoredPendingProgress(scope: string): Map<string, ReadingProgress> {
  try { migrateLegacy(scope); } catch { /* Read-only storage can still recover its old queue. */ }
  const winners = new Map<string, StoredEntry>();
  const legacy = browserStorage().getItem(scope);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as Record<string, ReadingProgress>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [bookId, progress] of Object.entries(parsed)) {
          if (progress?.bookId === bookId && typeof progress.updatedAt === 'string') {
            winners.set(bookId, { key: scope, progress, order: -1 });
          }
        }
      }
    } catch { /* Invalid legacy data must not hide current entries. */ }
  }
  for (const entry of entries(scope)) {
    const previous = winners.get(entry.progress.bookId);
    const time = previous ? compareProgressReadTime(entry.progress, previous.progress) : 1;
    if (!previous || time > 0 || (time === 0 && (entry.order > previous.order
      || (entry.order === previous.order && entry.key > previous.key)))) winners.set(entry.progress.bookId, entry);
  }
  return new Map([...winners].map(([bookId, entry]) => [bookId, entry.progress]));
}

export function writeStoredPendingProgress(scope: string, progress: ReadingProgress): void {
  migrateLegacy(scope);
  const previous = entries(scope).filter((entry) => entry.progress.bookId === progress.bookId);
  if (previous.some((entry) => compareProgressReadTime(entry.progress, progress) > 0)) return;
  // Persist the replacement before discarding any older intent. Distinct keys
  // also preserve simultaneous writes made by another browser process.
  createEntry(scope, progress);
  for (const entry of previous) browserStorage().removeItem(entry.key);
}

export function acknowledgeStoredPendingProgress(scope: string, progress: ReadingProgress): void {
  migrateLegacy(scope);
  for (const entry of entries(scope)) {
    if (entry.progress.bookId === progress.bookId && isProgressAcknowledged(entry.progress, progress)) {
      browserStorage().removeItem(entry.key);
    }
  }
}

export function clearStoredPendingProgress(scope: string): void {
  const storage = browserStorage();
  for (const entry of entries(scope)) storage.removeItem(entry.key);
  storage.removeItem(scope);
}
