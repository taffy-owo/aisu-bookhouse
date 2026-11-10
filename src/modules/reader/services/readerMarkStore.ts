import { getStoredSession } from '../../../shared/api/authTokenStore';
import type { ReaderMark } from '../types/reader';

const READER_MARKS_STORAGE_KEY = 'aisu-bookhouse:reader-marks';
let memoryReaderMarksStores: Record<string, Record<string, ReaderMark[]>> = {};

function getBrowserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readReaderMarkStore(): Record<string, ReaderMark[]> {
  const storageKey = getScopedStorageKey(READER_MARKS_STORAGE_KEY);

  try {
    const rawValue = getBrowserStorage()?.getItem(storageKey) ?? null;
    if (!rawValue) {
      return memoryReaderMarksStores[storageKey] ?? {};
    }

    return JSON.parse(rawValue) as Record<string, ReaderMark[]>;
  } catch {
    return memoryReaderMarksStores[storageKey] ?? {};
  }
}

export function writeReaderMarkStore(nextStore: Record<string, ReaderMark[]>): void {
  const storageKey = getScopedStorageKey(READER_MARKS_STORAGE_KEY);
  memoryReaderMarksStores = {
    ...memoryReaderMarksStores,
    [storageKey]: nextStore,
  };

  try {
    getBrowserStorage()?.setItem(storageKey, JSON.stringify(nextStore));
  } catch {
    // Private or hardened browser modes can reject storage writes.
  }
}

export function readLocalReaderMarks(bookId: string): ReaderMark[] {
  return readReaderMarkStore()[bookId] ?? [];
}

export function writeLocalReaderMarks(bookId: string, marks: ReaderMark[]): void {
  writeReaderMarkStore({
    ...readReaderMarkStore(),
    [bookId]: marks,
  });
}

function getScopedStorageKey(baseKey: string): string {
  const userId = getStoredSession()?.id;
  return userId ? `${baseKey}:${userId}` : baseKey;
}
