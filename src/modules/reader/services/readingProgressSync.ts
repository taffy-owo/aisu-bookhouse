import { ApiError, getStoredSession } from '../../../shared/api';
import type { ReadingProgress } from '../types/reader';
import { saveReadingProgress } from './readerService';
import { acknowledgeStoredPendingProgress, clearStoredPendingProgress, compareProgressReadTime, getProgressSignature,
  isProgressAcknowledged, progressStoragePrefix, readStoredPendingProgress, writeStoredPendingProgress } from './pendingProgressStorage';

const PROGRESS_SYNC_DELAY_MS = 5000;
const PROGRESS_SYNC_MAX_RETRY_DELAY_MS = 60_000;
const PROGRESS_SYNC_STORAGE_KEY = 'aisu-bookhouse:pending-reading-progress';

type SaveProgressOptions = {
  keepalive?: boolean;
};

type PendingProgressSync = {
  failureCount: number;
  progress: ReadingProgress;
  timerId: ReturnType<typeof setTimeout> | null;
  needsAttention: boolean;
};

export type ProgressSyncStatus = 'synced' | 'pending' | 'needs-attention';

let pendingProgressSyncs = new Map<string, PendingProgressSync>();
const accountProgressSyncs = new Map<string, Map<string, PendingProgressSync>>();
// Include removed books until their deletion reaches storage, so a quota error
// cannot restore an already acknowledged position when this account returns.
const dirtyProgressBooks = new Map<string, Set<string>>();
const unpersistedAcknowledgements = new Map<string, ReadingProgress[]>();
const supersededProgress = new Map<string, Map<string, ReadingProgress[]>>();
const accountFlushes = new Map<string, Map<string, Promise<void>>>();
const lastSavedProgressSignatures = new Map<string, string>();
const statusListeners = new Set<() => void>();
let hydratedStorageKey: string | null = null;
let statusNotificationPending = false;
let storageEventWindow: Window | null = null;
let storageRefreshNeeded = false;

export function subscribeReadingProgressSync(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function getReadingProgressSyncStatus(bookId: string): ProgressSyncStatus {
  ensurePendingProgressHydrated();
  const pending = pendingProgressSyncs.get(bookId);
  return pending ? (pending.needsAttention ? 'needs-attention' : 'pending') : 'synced';
}

export function getPendingReadingProgressSyncCount(): number {
  ensurePendingProgressHydrated();
  return pendingProgressSyncs.size;
}

/** A detached snapshot from the current account's durable queue. */
export function getPendingReadingProgress(bookId: string): ReadingProgress | null {
  ensurePendingProgressHydrated();
  const progress = pendingProgressSyncs.get(bookId)?.progress;
  return progress ? { ...progress } : null;
}

function notifyStatusListeners(): void {
  // Snapshot reads may hydrate an account during React rendering. Storage and
  // the snapshot remain immediate; notify mounted readers after that render,
  // coalescing repeated queue changes in the same task.
  if (statusNotificationPending) return;
  statusNotificationPending = true;
  queueMicrotask(() => {
    statusNotificationPending = false;
    for (const listener of statusListeners) listener();
  });
}

export function queueReadingProgressSync(bookId: string, progress: ReadingProgress): Promise<void> {
  ensurePendingProgressHydrated();
  refreshPendingProgressFromStorage();
  const shared = pendingProgressSyncs.get(bookId)?.progress;
  if (shared && compareProgressReadTime(shared, progress) > 0) return Promise.resolve();
  if (isProgressAlreadyQueuedOrSaved(bookId, progress)) {
    return Promise.resolve();
  }

  const currentSync = pendingProgressSyncs.get(bookId);
  if (currentSync) {
    const scope = hydratedStorageKey!;
    const superseded = supersededProgress.get(scope) ?? new Map<string, ReadingProgress[]>();
    superseded.set(bookId, [...(superseded.get(bookId) ?? []), currentSync.progress]);
    supersededProgress.set(scope, superseded);
    // Coalesce into the pending record but keep its existing deadline, so a
    // continuous stream of queues cannot postpone the save indefinitely.
    currentSync.progress = progress;
    currentSync.failureCount = 0;
    currentSync.needsAttention = false;
    persistPendingProgress(bookId);
    // Completion can arrive from page turns or layout restoration as well as
    // scroll events. Every path must confirm it without the normal debounce.
    if (progress.progressPercent === 100 && currentSync.timerId !== null) {
      globalThis.clearTimeout(currentSync.timerId);
      currentSync.timerId = null;
    }
    if (currentSync.timerId === null) {
      currentSync.timerId = scheduleFlush(bookId, progress.progressPercent === 100 ? 0 : PROGRESS_SYNC_DELAY_MS);
    }
    return Promise.resolve();
  }

  pendingProgressSyncs.set(bookId, {
    failureCount: 0,
    progress,
    timerId: scheduleFlush(bookId, progress.progressPercent === 100 ? 0 : PROGRESS_SYNC_DELAY_MS),
    needsAttention: false,
  });
  persistPendingProgress(bookId);

  return Promise.resolve();
}

// Serializes flushes per book: concurrent callers (chapter switch + pagehide,
// double-click) would otherwise race two PUTs whose completion order is not
// guaranteed, letting an older position land last on the server.
let inFlightFlushes = new Map<string, Promise<void>>();

export function flushReadingProgressSync(bookId: string, options: SaveProgressOptions = {}): Promise<void> {
  ensurePendingProgressHydrated();
  const scope = hydratedStorageKey;
  const flushes = inFlightFlushes;
  const previousFlush = flushes.get(bookId) ?? Promise.resolve();
  const currentFlush = previousFlush.catch(() => {}).then(() => performFlush(bookId, options, scope));
  flushes.set(bookId, currentFlush);
  void currentFlush
    .catch(() => {})
    .finally(() => {
      if (flushes.get(bookId) === currentFlush) {
        flushes.delete(bookId);
      }
    });
  return currentFlush;
}

async function performFlush(bookId: string, options: SaveProgressOptions, scope: string | null): Promise<void> {
  if (scope !== getPendingProgressStorageKey() || scope !== hydratedStorageKey) return;
  refreshPendingProgressFromStorage();
  const currentSync = pendingProgressSyncs.get(bookId);
  if (!currentSync) {
    return;
  }

  if (currentSync.timerId) {
    globalThis.clearTimeout(currentSync.timerId);
    currentSync.timerId = null;
  }

  const progressToSave = currentSync.progress;
  const signature = getProgressSignature(progressToSave);

  if (lastSavedProgressSignatures.get(bookId) === signature) {
    rememberAcknowledgement(progressToSave);
    pendingProgressSyncs.delete(bookId);
    persistPendingProgress(bookId);
    return;
  }

  // Once a request starts, the server may apply it even if its response is
  // lost. The earlier confirmed position is no longer safe to deduplicate.
  lastSavedProgressSignatures.delete(bookId);
  try {
    await saveReadingProgress(bookId, progressToSave, options);
  } catch (error: unknown) {
    if (scope !== getPendingProgressStorageKey() || scope !== hydratedStorageKey || pendingProgressSyncs.get(bookId) !== currentSync) return;
    // The response belongs to the attempted snapshot, not to a position queued
    // while it was in flight. Keep that newer position's deadline and status.
    if (currentSync.progress !== progressToSave) {
      if (currentSync.timerId === null) currentSync.timerId = scheduleFlush(bookId, PROGRESS_SYNC_DELAY_MS);
      throw error;
    }
    // Keep the pending progress so it is not lost; retry with exponential
    // backoff for transient failures. Auth/permission/not-found errors will
    // not resolve by retrying, so wait for a fresh queue instead.
    currentSync.failureCount += 1;
    if (isRetryableSaveError(error)) {
      const retryDelay = Math.min(PROGRESS_SYNC_DELAY_MS * 2 ** currentSync.failureCount, PROGRESS_SYNC_MAX_RETRY_DELAY_MS);
      currentSync.timerId = scheduleFlush(bookId, retryDelay);
    } else {
      currentSync.needsAttention = true;
      notifyStatusListeners();
    }
    throw error;
  }

  if (scope !== getPendingProgressStorageKey() || scope !== hydratedStorageKey || pendingProgressSyncs.get(bookId) !== currentSync) return;
  rememberAcknowledgement(progressToSave);
  lastSavedProgressSignatures.set(bookId, signature);
  const latestSync = pendingProgressSyncs.get(bookId);
  if (!latestSync || getProgressSignature(latestSync.progress) === signature) {
    // A -> B -> A during the request can leave B's deadline attached to A.
    // Remove it before discarding the record so it cannot flush a later queue.
    if (latestSync?.timerId) globalThis.clearTimeout(latestSync.timerId);
    pendingProgressSyncs.delete(bookId);
    persistPendingProgress(bookId);
    return;
  }

  // Newer progress arrived while the save was in flight; keep it scheduled.
  latestSync.failureCount = 0;
  persistPendingProgress(bookId);
  if (latestSync.timerId === null) {
    latestSync.timerId = scheduleFlush(bookId, PROGRESS_SYNC_DELAY_MS);
  }
}

export async function flushAllReadingProgressSyncs(options: SaveProgressOptions = {}): Promise<void[]> {
  ensurePendingProgressHydrated();
  const results = await Promise.allSettled(Array.from(pendingProgressSyncs.keys(), (bookId) => flushReadingProgressSync(bookId, options)));
  // Report failures after the entire batch settles, so a retry cannot begin
  // while another book from this same sync is still being saved.
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(() => undefined);
}

export function resumePendingReadingProgressSyncs(): void {
  ensurePendingProgressHydrated();
  for (const [bookId, sync] of pendingProgressSyncs) {
    if (sync.timerId === null && !sync.needsAttention) {
      sync.timerId = scheduleFlush(bookId, PROGRESS_SYNC_DELAY_MS);
    }
  }
}

export function resetReadingProgressSyncState(): void {
  for (const syncs of accountProgressSyncs.values()) {
    for (const sync of syncs.values()) {
      if (sync.timerId) globalThis.clearTimeout(sync.timerId);
    }
  }
  pendingProgressSyncs = new Map();
  accountProgressSyncs.clear();
  dirtyProgressBooks.clear();
  unpersistedAcknowledgements.clear();
  supersededProgress.clear();
  lastSavedProgressSignatures.clear();
  inFlightFlushes = new Map();
  accountFlushes.clear();
  clearPersistedPendingProgress();
  hydratedStorageKey = null;
  storageRefreshNeeded = false;
  storageEventWindow?.removeEventListener?.('storage', handleProgressStorageChange);
  storageEventWindow = null;
  notifyStatusListeners();
}

function scheduleFlush(bookId: string, delayMs: number): ReturnType<typeof setTimeout> {
  const scope = hydratedStorageKey;
  return globalThis.setTimeout(() => {
    if (scope !== getPendingProgressStorageKey()) {
      // Authentication may change before any component reads the sync status.
      // Pause the former account instead of flushing it with new credentials.
      ensurePendingProgressHydrated();
      return;
    }
    if (scope !== hydratedStorageKey) return;
    flushReadingProgressSync(bookId).catch(() => {
      // The pending progress is retained (and retried with backoff when the
      // failure is transient); timer-triggered flushes have no UI to notify.
    });
  }, delayMs);
}

function isRetryableSaveError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  return true;
}

function isProgressAlreadyQueuedOrSaved(bookId: string, progress: ReadingProgress): boolean {
  const signature = getProgressSignature(progress);
  const pendingProgress = pendingProgressSyncs.get(bookId)?.progress;
  // A pending detour must be replaced even when the reader has returned to
  // the last confirmed position. Only the latest queued intent is relevant.
  return pendingProgress
    ? getProgressSignature(pendingProgress) === signature
    : lastSavedProgressSignatures.get(bookId) === signature;
}

function ensurePendingProgressHydrated(): void {
  if (typeof window !== 'undefined' && storageEventWindow !== window) {
    storageEventWindow?.removeEventListener?.('storage', handleProgressStorageChange);
    storageEventWindow = window;
    window.addEventListener?.('storage', handleProgressStorageChange);
  }
  const storageKey = getPendingProgressStorageKey();
  if (hydratedStorageKey === storageKey) {
    if (storageRefreshNeeded) refreshPendingProgressFromStorage();
    return;
  }

  for (const sync of pendingProgressSyncs.values()) {
    if (sync.timerId) {
      globalThis.clearTimeout(sync.timerId);
      sync.timerId = null;
    }
  }
  const remembered = accountProgressSyncs.get(storageKey) ?? new Map<string, PendingProgressSync>();
  lastSavedProgressSignatures.clear();
  inFlightFlushes = accountFlushes.get(storageKey) ?? new Map();
  accountFlushes.set(storageKey, inFlightFlushes);
  hydratedStorageKey = storageKey;

  // New records also prevent an old in-flight response from clearing the
  // restored queue after an A -> B -> A account switch.
  pendingProgressSyncs = new Map([...remembered].map(([bookId, sync]) => [bookId, { ...sync, timerId: null }]));
  accountProgressSyncs.set(storageKey, pendingProgressSyncs);
  refreshPendingProgressFromStorage();
  for (const [bookId, sync] of pendingProgressSyncs) {
    if (!sync.needsAttention && sync.timerId === null) sync.timerId = scheduleFlush(bookId, PROGRESS_SYNC_DELAY_MS);
  }
  if (dirtyProgressBooks.get(storageKey)?.size || unpersistedAcknowledgements.get(storageKey)?.length) persistPendingProgress();
  else notifyStatusListeners();
}

function handleProgressStorageChange(event: StorageEvent): void {
  const scope = getPendingProgressStorageKey();
  if (event.key !== null && event.key !== scope && !event.key.startsWith(progressStoragePrefix(scope))) return;
  storageRefreshNeeded = true;
  ensurePendingProgressHydrated();
}

function refreshPendingProgressFromStorage(): void {
  if (!hydratedStorageKey) return;
  storageRefreshNeeded = false;
  try {
    const scope = hydratedStorageKey;
    const stored = readStoredPendingProgress(scope);
    const acknowledgements = unpersistedAcknowledgements.get(scope) ?? [];
    for (const [bookId, progress] of stored) {
      if (acknowledgements.some((ack) => ack.bookId === bookId && isProgressAcknowledged(progress, ack))) stored.delete(bookId);
    }
    for (const bookId of dirtyProgressBooks.get(scope) ?? []) {
      const memory = pendingProgressSyncs.get(bookId)?.progress, disk = stored.get(bookId);
      if (!memory) continue;
      const time = disk ? compareProgressReadTime(memory, disk) : 1;
      const superseded = supersededProgress.get(scope)?.get(bookId) ?? [];
      if (!disk || time > 0 || (time === 0 && (getProgressSignature(memory) === getProgressSignature(disk)
        || superseded.some((previous) => getProgressSignature(previous) === getProgressSignature(disk))))) stored.set(bookId, memory);
    }
    let changed = false;
    for (const [bookId, sync] of pendingProgressSyncs) {
      if (stored.has(bookId)) continue;
      if (sync.timerId !== null) globalThis.clearTimeout(sync.timerId);
      pendingProgressSyncs.delete(bookId);
      changed = true;
    }
    for (const [bookId, progress] of stored) {
      const current = pendingProgressSyncs.get(bookId);
      if (current && getProgressSignature(current.progress) === getProgressSignature(progress)) continue;
      if (current) {
        current.progress = progress;
        current.failureCount = 0;
        current.needsAttention = false;
        if (current.timerId === null) current.timerId = scheduleFlush(bookId, PROGRESS_SYNC_DELAY_MS);
      } else {
        pendingProgressSyncs.set(bookId, { progress, failureCount: 0, needsAttention: false,
          timerId: scheduleFlush(bookId, PROGRESS_SYNC_DELAY_MS) });
      }
      lastSavedProgressSignatures.delete(bookId);
      changed = true;
    }
    if (changed) notifyStatusListeners();
  } catch { /* Keep memory-only work while storage is unavailable. */ }
}

function rememberAcknowledgement(progress: ReadingProgress): void {
  if (!hydratedStorageKey) return;
  const acknowledgements = unpersistedAcknowledgements.get(hydratedStorageKey) ?? [];
  acknowledgements.push(progress);
  const current = pendingProgressSyncs.get(progress.bookId)?.progress;
  if (current && getProgressSignature(current) === getProgressSignature(progress)) {
    acknowledgements.push(...(supersededProgress.get(hydratedStorageKey)?.get(progress.bookId) ?? []));
    supersededProgress.get(hydratedStorageKey)?.delete(progress.bookId);
  }
  unpersistedAcknowledgements.set(hydratedStorageKey, acknowledgements);
}

function persistPendingProgress(bookId?: string): void {
  const storageKey = hydratedStorageKey ?? getPendingProgressStorageKey();
  const dirtyBooks = dirtyProgressBooks.get(storageKey) ?? new Set<string>();
  if (bookId) dirtyBooks.add(bookId);
  dirtyProgressBooks.set(storageKey, dirtyBooks);
  for (const id of dirtyBooks) {
    try {
      const progress = pendingProgressSyncs.get(id)?.progress;
      if (progress) {
        writeStoredPendingProgress(storageKey, progress);
        supersededProgress.get(storageKey)?.delete(id);
      }
      dirtyBooks.delete(id);
    } catch { /* Keep this book dirty until its intent is durable. */ }
  }
  const acknowledgements = unpersistedAcknowledgements.get(storageKey) ?? [];
  unpersistedAcknowledgements.set(storageKey, acknowledgements.filter((progress) => {
    try { acknowledgeStoredPendingProgress(storageKey, progress); return false; }
    catch { return true; }
  }));
  refreshPendingProgressFromStorage();
  notifyStatusListeners();
}

function clearPersistedPendingProgress(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    clearStoredPendingProgress(getPendingProgressStorageKey());
  } catch {
    // Ignore storage denial in tests/private mode.
  }
}

function getPendingProgressStorageKey(): string {
  const userId = getStoredSession()?.id;
  return userId ? `${PROGRESS_SYNC_STORAGE_KEY}:${userId}` : PROGRESS_SYNC_STORAGE_KEY;
}
