import { getAccountScope } from '../../../shared/api';
import type { CloudReadingActivitySummary } from './readingActivity';

export const READING_ACTIVITY_CHANGED_EVENT = 'aisu:reading-activity-changed';
export function notifyReadingActivityChanged(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(READING_ACTIVITY_CHANGED_EVENT));
}

interface CachedActivity {
  accountScope: string;
  savedAt: number;
  summary: CloudReadingActivitySummary;
  version: 1;
}
const memoryCache = new Map<string, CachedActivity>();

function cacheKey(scope: string): string | null {
  try {
    const id: unknown = JSON.parse(scope);
    return typeof id === 'string' && id ? `aisu-bookhouse:cloud-reading-activity:${encodeURIComponent(id)}` : null;
  } catch { return null; }
}
function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isSummary(value: unknown): value is CloudReadingActivitySummary {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return Array.isArray(data.days) && data.days.every((day: unknown) => {
    if (!day || typeof day !== 'object') return false;
    const row = day as Record<string, unknown>;
    return isDateKey(row.date_key) && isCount(row.seconds);
  }) && Array.isArray(data.book_totals) && data.book_totals.every((book: unknown) => {
    if (!book || typeof book !== 'object') return false;
    const row = book as Record<string, unknown>;
    return typeof row.book_id === 'string' && Boolean(row.book_id) && isCount(row.seconds)
      && (row.book_title == null || typeof row.book_title === 'string');
  }) && ['active_days', 'longest_streak_days', 'streak_days', 'today_seconds', 'total_seconds', 'week_seconds'].every((key) => isCount(data[key]))
    && [data.first_read_date, data.last_read_date].every((date) => date === null || isDateKey(date));
}

function parseEntry(raw: string | null, scope: string): CachedActivity | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as Partial<CachedActivity> | null;
    if (entry && entry.version === 1 && entry.accountScope === scope && typeof entry.savedAt === 'number'
      && Number.isFinite(entry.savedAt) && isSummary(entry.summary)) return entry as CachedActivity;
  } catch { /* One damaged snapshot must not hide the remaining confirmed history. */ }
  return null;
}

function newerEntry(current: CachedActivity | null, candidate: CachedActivity | null): CachedActivity | null {
  if (!candidate) return current;
  if (!current) return candidate;
  // The activity API only adds seconds, including for deleted books. A lower
  // total therefore identifies an older server snapshot, regardless of when
  // its HTTP response arrived. Equal totals may refresh calendar metadata.
  if (candidate.summary.total_seconds !== current.summary.total_seconds) {
    return candidate.summary.total_seconds > current.summary.total_seconds ? candidate : current;
  }
  return candidate.savedAt >= current.savedAt ? candidate : current;
}

function snapshotKeys(storage: Storage, key: string): string[] {
  const prefix = key + ':snapshots-v2:';
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((name): name is string => !!name?.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)));
}

function readEntry(key: string, scope: string): CachedActivity | null {
  let latest = memoryCache.get(scope) ?? null;
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : null;
    if (storage) {
      latest = newerEntry(latest, parseEntry(storage.getItem(key), scope));
      for (const name of snapshotKeys(storage, key)) {
        const entry = parseEntry(storage.getItem(name), scope);
        if (entry && name === key + ':snapshots-v2:' + entry.summary.total_seconds) latest = newerEntry(latest, entry);
      }
    }
  } catch { /* Keep the current-session copy when storage is unavailable. */ }
  if (latest) memoryCache.set(scope, latest);
  return latest;
}

export function readCloudReadingActivityCache(scope = getAccountScope()): CloudReadingActivitySummary | null {
  const key = cacheKey(scope);
  return key && scope === getAccountScope() ? readEntry(key, scope)?.summary ?? null : null;
}

export function saveCloudReadingActivityCache(summary: unknown, scope = getAccountScope()): CloudReadingActivitySummary | null {
  const key = cacheKey(scope);
  if (!key || scope !== getAccountScope() || !isSummary(summary)) return null;
  const previous = readEntry(key, scope);
  if (previous && previous.summary.total_seconds > summary.total_seconds) return previous.summary;
  const entry: CachedActivity = { version: 1, accountScope: scope, savedAt: Math.max(Date.now(), (previous?.savedAt ?? 0) + 1), summary };
  memoryCache.set(scope, entry);
  try {
    if (typeof window !== 'undefined') {
      const storage = window.localStorage;
      // Different confirmed totals use different keys. An old response cannot
      // overwrite a peer's newer snapshot between this tab's read and write.
      storage.setItem(key + ':snapshots-v2:' + summary.total_seconds, JSON.stringify(entry));
      for (const name of snapshotKeys(storage, key)) {
        const total = Number(name.slice((key + ':snapshots-v2:').length));
        // Prune only below a total already persisted successfully. A failed
        // write must leave the last durable snapshot available after reload.
        if (total < summary.total_seconds) storage.removeItem(name);
      }
      // Keep the original cache available to pages opened before this upgrade.
      storage.setItem(key, JSON.stringify(readEntry(key, scope) ?? entry));
    }
  } catch { /* The confirmed summary remains available in this session. */ }
  const latest = readEntry(key, scope)?.summary ?? summary;
  notifyReadingActivityChanged();
  return latest;
}
