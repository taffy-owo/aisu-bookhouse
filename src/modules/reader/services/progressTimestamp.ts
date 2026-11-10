import { getApiServerTime } from '../../../shared/api/serverClock';
import { getAccountScope } from '../../../shared/api/authTokenStore';

const observedProgressTimes = new Map<string, number>();
const MAX_OBSERVED_BOOKS = 200;

export function observeReadingProgressTimestamp(bookId: string, updatedAt: string, scope = getAccountScope()): void {
  if (scope !== getAccountScope()) return;
  const time = Date.parse(normalizeProgressTimestamp(updatedAt));
  if (!bookId || !Number.isFinite(time)) return;
  const key = JSON.stringify([scope, bookId]);
  const previous = observedProgressTimes.get(key);
  if (previous !== undefined && previous >= time) return;
  observedProgressTimes.delete(key);
  observedProgressTimes.set(key, time);
  if (observedProgressTimes.size > MAX_OBSERVED_BOOKS) observedProgressTimes.delete(observedProgressTimes.keys().next().value!);
}

/** Only new reading actions advance time; queued retries retain their original timestamp. */
export function createReadingProgressTimestamp(previous?: string, bookId?: string): string {
  const now = getApiServerTime();
  const previousTime = previous ? Date.parse(normalizeProgressTimestamp(previous)) : Number.NaN;
  const observed = bookId ? observedProgressTimes.get(JSON.stringify([getAccountScope(), bookId])) : undefined;
  return new Date(Math.max(now, Number.isFinite(previousTime) ? previousTime + 1 : -Infinity, observed === undefined ? -Infinity : observed + 1)).toISOString();
}

/**
 * Older local progress records omitted the UTC suffix. Treat those values as
 * UTC when sending them back to the API, while preserving already explicit
 * offsets and client generated timestamps byte for byte.
 */
export function normalizeProgressTimestamp(value: string): string {
  if (!value || /(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(value)) return value;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value) ? `${value}Z` : value;
}
