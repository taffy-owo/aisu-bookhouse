export type PendingReadingActivityEvent = {
  bookId?: string;
  dateKey: string;
  eventId: string;
  occurredAt: string;
  seconds: number;
};

type StoredActivityEvent = { event: PendingReadingActivityEvent; order: number };
let observedOrder = 0;

export function activityOutboxPrefix(scope: string): string {
  return `aisu-bookhouse:reading-activity-outbox-v2:${encodeURIComponent(scope)}:`;
}

function eventKey(scope: string, eventId: string): string {
  return activityOutboxPrefix(scope) + encodeURIComponent(eventId);
}

function storage(): Storage {
  if (typeof window === 'undefined') throw new Error('Storage unavailable');
  return window.localStorage;
}

function isEvent(value: unknown): value is PendingReadingActivityEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as PendingReadingActivityEvent;
  return typeof event.eventId === 'string' && Boolean(event.eventId)
    && typeof event.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.dateKey)
    && typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt))
    && Number.isFinite(event.seconds) && event.seconds > 0
    && (event.bookId === undefined || typeof event.bookId === 'string');
}

function legacyEvents(raw: string | null): PendingReadingActivityEvent[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter(isEvent) : [];
}

/** Each immutable event has its own key; peers never rewrite a shared array. */
export function persistActivityEvent(scope: string, event: PendingReadingActivityEvent, order?: number): void {
  const target = storage(), key = eventKey(scope, event.eventId);
  if (target.getItem(key) !== null) return;
  observedOrder = Math.max(observedOrder + 1, Date.now());
  target.setItem(key, JSON.stringify({ event, order: order ?? observedOrder }));
}

function migrateLegacy(scope: string): void {
  const target = storage(), raw = target.getItem(scope);
  if (raw === null) return;
  const events = legacyEvents(raw);
  // Every event must be durable before removing the old snapshot. Fixed event
  // keys make concurrent migrations and uncertain retries idempotent.
  for (let index = 0; index < events.length; index++) persistActivityEvent(scope, events[index], index);
  if (target.getItem(scope) === raw) target.removeItem(scope);
}

export function readStoredActivityEvents(scope: string): PendingReadingActivityEvent[] {
  try { migrateLegacy(scope); } catch { /* Read-only storage can still expose its original events. */ }
  const target = storage(), prefix = activityOutboxPrefix(scope), rawLegacy = target.getItem(scope);
  let legacy: PendingReadingActivityEvent[] = [];
  try { legacy = legacyEvents(rawLegacy); } catch { /* Preserve malformed legacy data without hiding valid new entries. */ }
  const events = new Map(legacy.map(event => [event.eventId, { event, order: -1 }]));
  const keys = Array.from({ length: target.length }, (_, index) => target.key(index))
    .filter((key): key is string => !!key?.startsWith(prefix));
  for (const key of keys) {
    const raw = target.getItem(key);
    if (!raw) continue;
    try {
      const row = JSON.parse(raw) as StoredActivityEvent;
      if (!isEvent(row.event) || !Number.isSafeInteger(row.order) || row.order < 0
        || key !== eventKey(scope, row.event.eventId)) continue;
      observedOrder = Math.max(observedOrder, row.order);
      events.set(row.event.eventId, row);
    } catch { /* One damaged event must not hide other pending reading time. */ }
  }
  return [...events.values()].sort((a, b) => a.order - b.order || a.event.eventId.localeCompare(b.event.eventId)).map(row => row.event);
}

export function acknowledgeActivityEvent(scope: string, eventId: string): void {
  try { migrateLegacy(scope); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  // Event identity is immutable. Removing this key cannot erase a peer's event.
  storage().removeItem(eventKey(scope, eventId));
}
