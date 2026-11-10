type ServerClockSample = { receivedAt: number; requestedAt: number; serverTime: number };
let sample: ServerClockSample | null = null;

/** Use fresh API response time instead of the device's adjustable wall clock. */
export function observeApiServerTime(headers: Headers, requestedAt: number, receivedAt = performance.now()): void {
  const date = headers.get('Date');
  const age = headers.get('Age');
  if (!date || (age !== null && (!Number.isFinite(Number(age)) || Number(age) > 0))
    || !Number.isFinite(requestedAt) || !Number.isFinite(receivedAt)
    || receivedAt < requestedAt || (sample && requestedAt < sample.requestedAt)) return;
  const serverTime = Date.parse(date);
  if (!Number.isFinite(serverTime)) return;
  // Keep the whole-second lower bound. Rounding up would put fresh positions
  // in the future and could temporarily outrank a manual reset on the server.
  sample = { requestedAt, receivedAt, serverTime };
}

export function getApiServerTime(): number {
  return sample ? sample.serverTime + Math.max(0, performance.now() - sample.receivedAt) : Date.now();
}

export function resetApiServerClock(): void {
  sample = null;
}
