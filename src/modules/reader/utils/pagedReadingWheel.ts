const WHEEL_TURN_THRESHOLD_PX = 28;
const WHEEL_TURN_INTERVAL_MS = 320;
const WHEEL_GESTURE_GAP_MS = 220;

type WheelMotion = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>;

/** Keep separate gestures and directions from contributing to the same turn. */
export function createPagedReadingWheel() {
  let accumulated = 0;
  let lastDirection = 0;
  let lastMotionAt = -Infinity;
  let lastTurnAt = -Infinity;

  return (motion: WheelMotion, viewportHeight: number, now: number): -1 | 0 | 1 => {
    const raw = Math.abs(motion.deltaY) >= Math.abs(motion.deltaX) ? motion.deltaY : motion.deltaX;
    const delta = raw * (motion.deltaMode === 1 ? 16 : motion.deltaMode === 2 ? viewportHeight : 1);
    if (!Number.isFinite(delta) || delta === 0) return 0;

    const direction = delta > 0 ? 1 : -1;
    if (direction !== lastDirection || now - lastMotionAt >= WHEEL_GESTURE_GAP_MS) accumulated = 0;
    lastDirection = direction;
    lastMotionAt = now;
    // Discard the tail of the previous turn instead of saving it for later.
    if (now - lastTurnAt < WHEEL_TURN_INTERVAL_MS) {
      accumulated = 0;
      return 0;
    }

    accumulated += delta;
    if (Math.abs(accumulated) < WHEEL_TURN_THRESHOLD_PX) return 0;
    accumulated = 0;
    lastTurnAt = now;
    return direction;
  };
}
