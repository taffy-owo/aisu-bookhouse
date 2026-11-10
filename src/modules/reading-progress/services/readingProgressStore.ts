import { getStoredSession } from '../../../shared/api/authTokenStore';
import type { ReadingProgress } from '../types/readingProgress';

const READING_PROGRESS_STORAGE_KEY = 'aisu-bookhouse:reading-progress';
let memoryProgressStores: Record<string, Record<string, ReadingProgress>> = {};

function getBrowserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readProgressStore(): Record<string, ReadingProgress> {
  const storageKey = getScopedStorageKey(READING_PROGRESS_STORAGE_KEY);

  try {
    const rawValue = getBrowserStorage()?.getItem(storageKey) ?? null;

    if (!rawValue) {
      return memoryProgressStores[storageKey] ?? {};
    }

    return JSON.parse(rawValue) as Record<string, ReadingProgress>;
  } catch {
    return memoryProgressStores[storageKey] ?? {};
  }
}

export function writeProgressStore(nextStore: Record<string, ReadingProgress>): void {
  const storageKey = getScopedStorageKey(READING_PROGRESS_STORAGE_KEY);
  memoryProgressStores = {
    ...memoryProgressStores,
    [storageKey]: nextStore,
  };

  try {
    getBrowserStorage()?.setItem(storageKey, JSON.stringify(nextStore));
  } catch {
    // Private or hardened browser modes can reject storage writes.
  }
}

export function getRawReadingProgress(bookId: string): ReadingProgress | null {
  return readProgressStore()[bookId] ?? null;
}

export function saveReadingProgress(bookId: string, progress: ReadingProgress): void {
  writeProgressStore({
    ...readProgressStore(),
    [bookId]: progress,
  });
}

function getScopedStorageKey(baseKey: string): string {
  const userId = getStoredSession()?.id;
  return userId ? `${baseKey}:${userId}` : baseKey;
}
