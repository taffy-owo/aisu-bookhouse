import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface ReaderTouchGesturesOptions {
  allowRubyEdgePageTurns?: boolean;
  /** Attach while the reader is interactive; resolve the input per gesture. */
  enabled: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onTap?: (point: { clientX: number; clientY: number }) => void;
  targetRef: RefObject<HTMLElement | null>;
}

// A swipe must be decisively horizontal and quick; anything else is scrolling
// or text selection and must pass through untouched.
const SWIPE_MIN_DISTANCE_PX = 64;
const SWIPE_MAX_DURATION_MS = 600;
const SWIPE_HORIZONTAL_DOMINANCE = 2;
// Touches starting at the screen edge belong to the system (browser back /
// forward navigation gestures) — never claim them.
const SYSTEM_EDGE_PX = 24;
const TAP_MAX_MOVEMENT_PX = 12;
const COMPATIBILITY_CLICK_MS = 800;

const INTERACTIVE_TARGET = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="dialog"], [contenteditable="true"], [data-reader-no-page-turn], .reader-furigana-on-demand ruby';

export function isReaderInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_TARGET));
}

/** At the sides, reading illustrations and ruby text share the page-turn zone. */
export function isReaderEdgePageTarget(target: EventTarget | null, clientX: number, element: HTMLElement, allowRuby = true): boolean {
  const selector = allowRuby ? '[data-reader-edge-page-turn], .reader-furigana-on-demand ruby' : '[data-reader-edge-page-turn]';
  if (!(target instanceof Element) || !target.closest(selector)) return false;
  const bounds = element.getBoundingClientRect();
  const x = clientX - bounds.left;
  return x < bounds.width * 0.28 || x > bounds.width * 0.72;
}

export function useReaderTouchGestures({ allowRubyEdgePageTurns = false, enabled, onSwipeLeft, onSwipeRight, onTap, targetRef }: ReaderTouchGesturesOptions) {
  const lastTouchEndedAt = useRef(0);
  const suppressClickUntil = useRef(0);
  const claimedTap = useRef<{ clientX: number; clientY: number; until: number } | null>(null);
  const lastPointerType = useRef('');
  const callbacksRef = useRef({ onSwipeLeft, onSwipeRight, onTap });
  useEffect(() => {
    callbacksRef.current = { onSwipeLeft, onSwipeRight, onTap };
  }, [onSwipeLeft, onSwipeRight, onTap]);
  const shouldIgnoreClick = useCallback(() => Date.now() < suppressClickUntil.current, []);
  const isTouchClick = useCallback((event: MouseEvent) => {
    // iPadOS can report a fine primary pointer when a mouse is attached.
    // Use the input that produced this click, not the viewport or primary pointer.
    const pointerType = (event as PointerEvent).pointerType;
    if (pointerType) return pointerType === 'touch' || pointerType === 'pen';
    const capabilities = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities;
    if (capabilities?.firesTouchEvents) return true;
    return lastPointerType.current !== 'mouse' && Date.now() - lastTouchEndedAt.current < COMPATIBILITY_CLICK_MS;
  }, []);

  useEffect(() => {
    // Showing controls on touchend can put a new button beneath the finger.
    // Its compatibility click is then retargeted outside the reading surface,
    // so intercept it before it reaches that button or React's event root.
    const resetClaimedTap = () => { claimedTap.current = null; };
    const handleClaimedTapClick = (event: MouseEvent) => {
      const tap = claimedTap.current;
      if (!tap || Date.now() >= tap.until || event.detail === 0) return;
      const pointerType = (event as PointerEvent).pointerType;
      if (pointerType && pointerType !== 'touch' && pointerType !== 'pen') return;
      if (Math.hypot(event.clientX - tap.clientX, event.clientY - tap.clientY) > TAP_MAX_MOVEMENT_PX) return;
      claimedTap.current = null;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('pointerdown', resetClaimedTap, true);
    document.addEventListener('touchstart', resetClaimedTap, { capture: true, passive: true });
    document.addEventListener('click', handleClaimedTapClick, true);
    return () => {
      document.removeEventListener('pointerdown', resetClaimedTap, { capture: true });
      document.removeEventListener('touchstart', resetClaimedTap, { capture: true });
      document.removeEventListener('click', handleClaimedTapClick, { capture: true });
    };
  }, []);

  useEffect(() => {
    const target = targetRef.current;
    if (!enabled || !target || typeof window === 'undefined') {
      return;
    }
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let isTracking = false;
    let hasMoved = false;
    let selectionAtPointerDown = false;
    let hasSelectionAtStart = false;

    const hasTextSelection = () => {
      const selection = window.getSelection();
      return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
    };

    const handlePointerDown = (event: PointerEvent) => {
      lastPointerType.current = event.pointerType;
      selectionAtPointerDown = hasTextSelection();
      if (event.pointerType === 'mouse') {
        suppressClickUntil.current = 0;
        claimedTap.current = null;
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      claimedTap.current = null;
      const point = event.touches[0];
      const edgeTap = point && callbacksRef.current.onTap && isReaderEdgePageTarget(event.target, point.clientX, target, allowRubyEdgePageTurns);
      if (event.touches.length !== 1 || (isReaderInteractiveTarget(event.target) && !edgeTap)) {
        isTracking = false;
        suppressClickUntil.current = Date.now() + COMPATIBILITY_CLICK_MS;
        return;
      }

      const touch = event.touches[0];
      lastPointerType.current = 'touch';
      // A real touch may clear the selection before its compatibility click.
      // That first tap dismisses selection; it must not also advance the page.
      hasSelectionAtStart = selectionAtPointerDown || hasTextSelection();
      selectionAtPointerDown = false;
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = Date.now();
      isTracking = true;
      hasMoved = false;
      suppressClickUntil.current = 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        isTracking = false;
        suppressClickUntil.current = Date.now() + COMPATIBILITY_CLICK_MS;
        return;
      }
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > TAP_MAX_MOVEMENT_PX) hasMoved = true;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      lastTouchEndedAt.current = Date.now();
      if (!isTracking) {
        suppressClickUntil.current = Date.now() + COMPATIBILITY_CLICK_MS;
        return;
      }
      isTracking = false;

      const touch = event.changedTouches[0];
      if (!touch) {
        return;
      }

      // Cheap geometry rejection first — this handler runs on every touch
      // (i.e. every scroll flick), so bail before any expensive work.
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const elapsed = Date.now() - startedAt;

      if (hasSelectionAtStart || hasMoved || Math.hypot(deltaX, deltaY) > TAP_MAX_MOVEMENT_PX || elapsed > SWIPE_MAX_DURATION_MS) {
        // A scroll, swipe, pinch or long press must not also become a page tap.
        suppressClickUntil.current = Date.now() + COMPATIBILITY_CLICK_MS;
      }

      if (hasSelectionAtStart || elapsed > SWIPE_MAX_DURATION_MS) {
        return;
      }
      if (!hasMoved && Math.hypot(deltaX, deltaY) <= TAP_MAX_MOVEMENT_PX && callbacksRef.current.onTap && !hasTextSelection()) {
        // Some touch browsers never dispatch a compatibility click. Handle a
        // real tap once here and discard any click that follows it.
        suppressClickUntil.current = Date.now() + COMPATIBILITY_CLICK_MS;
        claimedTap.current = { clientX: touch.clientX, clientY: touch.clientY, until: suppressClickUntil.current };
        callbacksRef.current.onTap({ clientX: touch.clientX, clientY: touch.clientY });
        return;
      }
      if (startX < SYSTEM_EDGE_PX || startX > window.innerWidth - SYSTEM_EDGE_PX) return;
      if (Math.abs(deltaX) < SWIPE_MIN_DISTANCE_PX) {
        return;
      }
      if (Math.abs(deltaX) < Math.abs(deltaY) * SWIPE_HORIZONTAL_DOMINANCE) {
        return;
      }

      // Only now check for an active text selection (serializing the
      // selection over a long chapter is costly, so it must come last).
      if (window.getSelection()?.toString().trim()) {
        return;
      }

      if (deltaX < 0) {
        callbacksRef.current.onSwipeLeft?.();
      } else {
        callbacksRef.current.onSwipeRight?.();
      }
    };

    const handleTouchCancel = () => {
      isTracking = false;
      suppressClickUntil.current = Date.now() + COMPATIBILITY_CLICK_MS;
    };

    target.addEventListener('pointerdown', handlePointerDown, { passive: true });
    target.addEventListener('touchstart', handleTouchStart, { passive: true });
    target.addEventListener('touchmove', handleTouchMove, { passive: true });
    target.addEventListener('touchend', handleTouchEnd, { passive: true });
    target.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      target.removeEventListener('pointerdown', handlePointerDown);
      target.removeEventListener('touchstart', handleTouchStart);
      target.removeEventListener('touchmove', handleTouchMove);
      target.removeEventListener('touchend', handleTouchEnd);
      target.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [allowRubyEdgePageTurns, enabled, targetRef]);

  return { isTouchClick, shouldIgnoreClick };
}
