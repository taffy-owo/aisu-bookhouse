import { getAccountScope } from '../../../shared/api/authTokenStore';
import { ApiError, apiRequest, assertAccountScope, isBackendApiEnabled } from '../../../shared/api';
import { notifyReadingActivityChanged, readCloudReadingActivityCache, saveCloudReadingActivityCache } from './readingActivityCache';
import { acknowledgeActivityEvent, persistActivityEvent, readStoredActivityEvents, type PendingReadingActivityEvent } from './readingActivityOutbox';
import { incrementLocalReadingSeconds, readLocalReadingSeconds, replaceLocalReadingSeconds } from './localReadingTime';
import { summarizeReadingWeek } from './readingWeek';

export interface ReadingActivitySummary {
  lastReadDate: string | null;
  streakDays: number;
  todaySeconds: number;
  totalSeconds: number;
  weekSeconds: number;
}

export type ReadingActivityStore = Record<string, number>;

export interface CloudReadingActivityDay {
  date_key: string;
  seconds: number;
}

export interface CloudReadingActivityBookTotal {
  book_id: string;
  book_title?: string | null;
  seconds: number;
}

export interface CloudReadingActivitySummary {
  active_days: number;
  book_totals: CloudReadingActivityBookTotal[];
  days: CloudReadingActivityDay[];
  first_read_date: string | null;
  last_read_date: string | null;
  longest_streak_days: number;
  streak_days: number;
  today_seconds: number;
  total_seconds: number;
  week_seconds: number;
}

const READING_ACTIVITY_STORAGE_KEY = 'aisu-bookhouse:reading-activity';
const READING_ACTIVITY_OUTBOX_KEY = 'aisu-bookhouse:reading-activity-outbox';
const activityOutboxFlushes = new Map<string, Promise<void>>();
const memoryActivityOutboxes = new Map<string, PendingReadingActivityEvent[]>();
const memoryOnlyActivityEvents = new Map<string, Set<string>>();
const acknowledgedActivityEvents = new Map<string, Set<string>>();
const activitySummaryReads = new Map<string, number>();

export interface PendingReadingActivitySummary {
  eventCount: number;
  seconds: number;
}

export function readReadingActivityStore(): ReadingActivityStore {
  return readLocalReadingSeconds(getScopedStorageKey(READING_ACTIVITY_STORAGE_KEY), normalizeReadingActivityStore);
}

export function writeReadingActivityStore(nextStore: ReadingActivityStore): void {
  replaceLocalReadingSeconds(getScopedStorageKey(READING_ACTIVITY_STORAGE_KEY), normalizeReadingActivityStore(nextStore));
  notifyReadingActivityChanged();
}

const BOOK_READING_TIME_STORAGE_KEY = 'aisu-bookhouse:book-reading-time';

export function readBookReadingTimeStore(): Record<string, number> {
  return readLocalReadingSeconds(getScopedStorageKey(BOOK_READING_TIME_STORAGE_KEY), normalizeSecondsStore);
}

export function writeBookReadingTimeStore(store: Record<string, number>): void {
  replaceLocalReadingSeconds(getScopedStorageKey(BOOK_READING_TIME_STORAGE_KEY), normalizeSecondsStore(store));
}

export function recordBookReadingTime(bookId: string, seconds: number, accountScope = getAccountScope()): void {
  const safeSeconds = normalizeSeconds(seconds);
  if (safeSeconds <= 0) return;
  incrementLocalReadingSeconds(getScopedStorageKey(BOOK_READING_TIME_STORAGE_KEY, accountScope), bookId, safeSeconds, normalizeSecondsStore);
}

export function getBookReadingTime(bookId: string): number {
  return normalizeSeconds(readBookReadingTimeStore()[bookId]);
}

function getScopedStorageKey(baseKey: string, accountScope = getAccountScope()): string {
  const userId: unknown = JSON.parse(accountScope);
  return typeof userId === 'string' && userId ? `${baseKey}:${userId}` : baseKey;
}

export function recordReadingActivity(seconds: number, now: Date = new Date(), bookId?: string, accountScope = getAccountScope()): ReadingActivitySummary {
  const safeSeconds = normalizeSeconds(seconds);

  if (safeSeconds <= 0) {
    return getReadingActivitySummary(now, accountScope);
  }

  const dateKey = formatLocalDateKey(now);
  incrementLocalReadingSeconds(getScopedStorageKey(READING_ACTIVITY_STORAGE_KEY, accountScope), dateKey, safeSeconds, normalizeReadingActivityStore);

  if (bookId) {
    recordBookReadingTime(bookId, safeSeconds, accountScope);
  }

  notifyReadingActivityChanged();
  return getReadingActivitySummary(now, accountScope);
}

export function getReadingActivitySummary(now = new Date(), accountScope = getAccountScope()): ReadingActivitySummary {
  return summarizeReadingActivityStore(readLocalReadingSeconds(getScopedStorageKey(READING_ACTIVITY_STORAGE_KEY, accountScope), normalizeReadingActivityStore), now);
}

export function summarizeReadingActivityStore(store: ReadingActivityStore, now = new Date()): ReadingActivitySummary {
  const todayKey = formatLocalDateKey(now);
  const lastReadDate = Object.entries(store)
    .filter(([, seconds]) => seconds > 0)
    .map(([dateKey]) => dateKey)
    .sort()
    .at(-1) ?? null;

  return {
    lastReadDate,
    streakDays: countReadingStreakDays(store, now),
    todaySeconds: store[todayKey] ?? 0,
    totalSeconds: sumSeconds(Object.values(store)),
    weekSeconds: summarizeReadingWeek(store, now).seconds,
  };
}

export async function fetchCloudReadingActivitySummary(signal?: AbortSignal): Promise<CloudReadingActivitySummary | null> {
  if (!isBackendApiEnabled()) {
    return null;
  }

  const scope = getAccountScope();
  const readVersion = (activitySummaryReads.get(scope) ?? 0) + 1;
  activitySummaryReads.set(scope, readVersion);
  const previousSnapshot = JSON.stringify(readCloudReadingActivityCache(scope));
  const summary = await apiRequest<CloudReadingActivitySummary>('/reading-activity', { signal });
  if (signal?.aborted) return summary;
  const currentSnapshot = readCloudReadingActivityCache(scope);
  // A POST acknowledgement, peer-tab update, or newer read may have already
  // published a snapshot while this GET was in flight. Return that snapshot
  // to the caller as well, so its page state cannot undo the shared cache.
  if (activitySummaryReads.get(scope) !== readVersion || JSON.stringify(currentSnapshot) !== previousSnapshot) {
    if (currentSnapshot && currentSnapshot.total_seconds >= summary.total_seconds) return currentSnapshot;
  }
  return saveCloudReadingActivityCache(summary, scope) ?? summary;
}

export async function syncReadingActivity(seconds: number, now: Date = new Date(), bookId?: string, options: { keepalive?: boolean } = {}): Promise<CloudReadingActivitySummary | null> {
  const scope = getAccountScope();
  if (!isBackendApiEnabled()) {
    return null;
  }

  const safeSeconds = normalizeSeconds(seconds);
  if (safeSeconds <= 0) {
    return null;
  }

  const summary = await apiRequest<CloudReadingActivitySummary>('/reading-activity', {
    body: JSON.stringify({
      book_id: bookId ?? null,
      date_key: formatLocalDateKey(now),
      event_id: createActivityEventId(),
      occurred_at: now.toISOString(),
      seconds: safeSeconds,
    }),
    // keepalive lets flushes fired during pagehide survive page teardown.
    keepalive: options.keepalive,
    method: 'POST',
  });
  return saveCloudReadingActivityCache(summary, scope) ?? summary;
}

/**
 * Persist an activity event before attempting the network request. Failed
 * events survive reload/offline/page teardown and are replayed in order.
 * Server-side event ids make uncertain retries safe and idempotent.
 */
export function queueReadingActivitySync(seconds: number, now: Date = new Date(), bookId?: string, options: { keepalive?: boolean; accountScope?: string } = {}): Promise<void> {
  if (!isBackendApiEnabled()) {
    return Promise.resolve();
  }

  const safeSeconds = normalizeSeconds(seconds);
  if (safeSeconds <= 0) {
    return Promise.resolve();
  }

  const scope = options.accountScope ?? getAccountScope();
  const outbox = readReadingActivityOutbox(scope);
  const event: PendingReadingActivityEvent = {
    bookId,
    dateKey: formatLocalDateKey(now),
    eventId: createActivityEventId(),
    occurredAt: now.toISOString(),
    seconds: safeSeconds,
  };
  const key = getScopedStorageKey(READING_ACTIVITY_OUTBOX_KEY, scope);
  memoryActivityOutboxes.set(key, [...outbox, event]);
  const unsaved = memoryOnlyActivityEvents.get(key) ?? new Set<string>();
  unsaved.add(event.eventId);
  memoryOnlyActivityEvents.set(key, unsaved);
  persistMemoryActivityEvents(scope);
  notifyReadingActivityChanged();
  // A peer tab may have already replaced the credentials. Retain the old
  // account's tail on disk and replay only after that account signs in again.
  return scope === getAccountScope() ? flushReadingActivityOutbox(options) : Promise.resolve();
}

export function flushReadingActivityOutbox(options: { keepalive?: boolean } = {}): Promise<void> {
  if (!isBackendApiEnabled()) {
    return Promise.resolve();
  }
  const scope = getAccountScope();
  const current = activityOutboxFlushes.get(scope);
  if (current) return current;

  const request = performReadingActivityOutboxFlush(options, scope).finally(() => {
    if (activityOutboxFlushes.get(scope) === request) {
      activityOutboxFlushes.delete(scope);
    }
  });
  activityOutboxFlushes.set(scope, request);
  return request;
}

async function performReadingActivityOutboxFlush(options: { keepalive?: boolean }, scope: string): Promise<void> {
  const key = getScopedStorageKey(READING_ACTIVITY_OUTBOX_KEY, scope);
  while (getAccountScope() === scope) {
    const event = readReadingActivityOutbox(scope)[0];
    if (!event) {
      // Retry local cleanup without resending acknowledged events when browser
      // storage becomes writable again during this same session.
      cleanupAcknowledgedActivityEvents(scope);
      return;
    }

    const payload = {
      book_id: event.bookId ?? null,
      date_key: event.dateKey,
      event_id: event.eventId,
      occurred_at: event.occurredAt,
      seconds: event.seconds,
    };
    const requestOptions = { keepalive: options.keepalive, method: 'POST' };
    let summary: CloudReadingActivitySummary;
    try {
      summary = await apiRequest<CloudReadingActivitySummary>('/reading-activity', {
        ...requestOptions, body: JSON.stringify(payload),
      });
    } catch (error: unknown) {
      // A shared book can become private while its reader is offline. Preserve
      // the daily seconds without the unavailable book instead of blocking all
      // later events. Keep the event ID so retries remain idempotent.
      if (!payload.book_id || !(error instanceof ApiError) || error.status !== 404
        || !error.payload || typeof error.payload !== 'object' || !('detail' in error.payload)
        || error.payload.detail !== 'Book not found') throw error;
      assertAccountScope(scope);
      summary = await apiRequest<CloudReadingActivitySummary>('/reading-activity', {
        ...requestOptions, body: JSON.stringify({ ...payload, book_id: null }),
      });
    }

    if (getAccountScope() !== scope) return;
    const acknowledged = acknowledgedActivityEvents.get(key) ?? new Set<string>();
    acknowledged.add(event.eventId);
    acknowledgedActivityEvents.set(key, acknowledged);
    memoryOnlyActivityEvents.get(key)?.delete(event.eventId);
    memoryActivityOutboxes.set(key, (memoryActivityOutboxes.get(key) ?? []).filter(item => item.eventId !== event.eventId));
    cleanupAcknowledgedActivityEvents(scope);
    saveCloudReadingActivityCache(summary, scope);
    notifyReadingActivityChanged();
  }
}

function readReadingActivityOutbox(accountScope = getAccountScope()): PendingReadingActivityEvent[] {
  const key = getScopedStorageKey(READING_ACTIVITY_OUTBOX_KEY, accountScope);
  persistMemoryActivityEvents(accountScope);
  let events = memoryActivityOutboxes.get(key) ?? [];
  try {
    const stored = readStoredActivityEvents(key), unsaved = memoryOnlyActivityEvents.get(key);
    // Only unpublished local events are merged. A peer acknowledgement must
    // not be revived from an older in-memory copy of the entire outbox.
    events = [...new Map([...stored, ...events.filter(event => unsaved?.has(event.eventId))]
      .map(event => [event.eventId, event])).values()];
  } catch {
    // The current-session copy survives read denial and malformed storage.
  }
  const acknowledged = acknowledgedActivityEvents.get(key);
  const pending = events.filter((event) => !acknowledged?.has(event.eventId));
  memoryActivityOutboxes.set(key, pending);
  return pending;
}

function persistMemoryActivityEvents(accountScope: string): void {
  const key = getScopedStorageKey(READING_ACTIVITY_OUTBOX_KEY, accountScope);
  const unsaved = memoryOnlyActivityEvents.get(key);
  if (!unsaved?.size) return;
  for (const event of memoryActivityOutboxes.get(key) ?? []) {
    if (!unsaved.has(event.eventId)) continue;
    try {
      persistActivityEvent(key, event);
      unsaved.delete(event.eventId);
    } catch { /* Retain this event in memory until storage becomes writable. */ }
  }
  if (!unsaved.size) memoryOnlyActivityEvents.delete(key);
}

function cleanupAcknowledgedActivityEvents(accountScope: string): void {
  const key = getScopedStorageKey(READING_ACTIVITY_OUTBOX_KEY, accountScope);
  const acknowledged = acknowledgedActivityEvents.get(key);
  if (!acknowledged) return;
  for (const eventId of acknowledged) {
    try {
      acknowledgeActivityEvent(key, eventId);
      acknowledged.delete(eventId);
    } catch { /* Do not resend a successful event while local cleanup is denied. */ }
  }
  if (!acknowledged.size) acknowledgedActivityEvents.delete(key);
}

export function getPendingReadingActivitySummary(): PendingReadingActivitySummary {
  const events = readReadingActivityOutbox();
  return { eventCount: events.length, seconds: events.reduce((total, event) => total + normalizeSeconds(event.seconds), 0) };
}

function createActivityEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function cloudActivitySummaryToStore(summary: CloudReadingActivitySummary | null): ReadingActivityStore {
  if (!summary) {
    return {};
  }

  return Object.fromEntries(summary.days.map((day) => [day.date_key, normalizeSeconds(day.seconds)]));
}

export function cloudActivitySummaryToBookTimeStore(summary: CloudReadingActivitySummary | null): Record<string, number> {
  if (!summary) {
    return {};
  }

  return Object.fromEntries(summary.book_totals.map((bookTotal) => [bookTotal.book_id, normalizeSeconds(bookTotal.seconds)]));
}

export function mergeSecondsStores(...stores: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const store of stores) {
    for (const [key, seconds] of Object.entries(store)) {
      merged[key] = Math.max(merged[key] ?? 0, normalizeSeconds(seconds));
    }
  }
  return merged;
}

export function formatReadingDuration(seconds: number): string {
  const safeSeconds = normalizeSeconds(seconds);

  if (safeSeconds < 60) {
    return safeSeconds > 0 ? '不到 1 分钟' : '0 分钟';
  }

  const totalMinutes = Math.round(safeSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes} 分钟`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function countReadingStreakDays(store: ReadingActivityStore, now: Date): number {
  const todayKey = formatLocalDateKey(now);
  const anchorDate = store[todayKey] > 0 ? now : addLocalDays(now, -1);
  let streakDays = 0;

  for (let dayOffset = 0; dayOffset < 3650; dayOffset += 1) {
    const dateKey = formatLocalDateKey(addLocalDays(anchorDate, -dayOffset));

    if (!store[dateKey]) {
      break;
    }

    streakDays += 1;
  }

  return streakDays;
}

function normalizeSecondsStore(store: unknown): ReadingActivityStore {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return {};
  return Object.fromEntries(Object.entries(store)
    .filter(([key, seconds]) => key && typeof seconds === 'number' && normalizeSeconds(seconds) > 0)
    .map(([key, seconds]) => [key, normalizeSeconds(seconds)]));
}

function normalizeReadingActivityStore(store: unknown): ReadingActivityStore {
  return Object.fromEntries(
    Object.entries(normalizeSecondsStore(store))
      .filter(([dateKey, seconds]) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey) && normalizeSeconds(seconds) > 0)
      .map(([dateKey, seconds]) => [dateKey, normalizeSeconds(seconds)]),
  );
}

function normalizeSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
}

function sumSeconds(secondsList: number[]): number {
  return secondsList.reduce((totalSeconds, seconds) => totalSeconds + normalizeSeconds(seconds), 0);
}

function addLocalDays(date: Date, dayOffset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
}

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}
