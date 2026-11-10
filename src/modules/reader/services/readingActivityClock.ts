const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_FLUSH_SECONDS = 60;

/** Counts readable, visible intervals while retaining fractions across pauses. */
export function createReadingActivityClock(onSeconds: (seconds: number, occurredAt: Date) => void, now = () => performance.now(), wallNow = () => Date.now()) {
  let active = false;
  let observedAt = now();
  let interactedAt = observedAt;
  const pendingDays = new Map<string, { milliseconds: number; occurredAt: Date }>();

  const addInterval = (start: number, end: number) => {
    while (start < end) {
      const date = new Date(start);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      // Calendar construction handles 23/25-hour days and fractional zones.
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const next = Math.min(end, midnight);
      if (next <= start) break;
      const bucket = pendingDays.get(key);
      pendingDays.set(key, { milliseconds: (bucket?.milliseconds ?? 0) + next - start, occurredAt: new Date(next - 1) });
      start = next;
    }
  };

  const observe = (at: number) => {
    if (active) {
      const until = Math.min(at, interactedAt + IDLE_TIMEOUT_MS);
      const duration = Math.max(0, until - observedAt);
      // Wall-clock changes cannot create elapsed time. Project only measured
      // readable time onto the local calendar, excluding the idle tail.
      const end = wallNow() - Math.max(0, at - until);
      if (Number.isFinite(end) && duration > 0) addInterval(end - duration, end);
    }
    observedAt = at;
  };
  const emit = () => {
    let remaining = MAX_FLUSH_SECONDS;
    for (const [key, bucket] of pendingDays) {
      const seconds = Math.floor(bucket.milliseconds / 1000);
      bucket.milliseconds -= seconds * 1000;
      // Drop suspended excess once, retaining each day's fractional remainder.
      if (seconds > 0 && remaining > 0) {
        const recorded = Math.min(remaining, seconds);
        remaining -= recorded;
        onSeconds(recorded, bucket.occurredAt);
      }
      if (bucket.milliseconds <= 0) pendingDays.delete(key);
    }
  };

  return {
    setActive(next: boolean) {
      if (next === active) return;
      const at = now();
      observe(at);
      emit();
      active = next;
      observedAt = at;
      if (active) interactedAt = at;
    },
    interact() {
      const at = now();
      observe(at);
      if (active) interactedAt = at;
    },
    flush() { observe(now()); emit(); },
  };
}
