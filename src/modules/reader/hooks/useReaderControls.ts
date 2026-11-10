import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

const DEFAULT_AUTO_HIDE_DELAY_MS = 3_200;

function hasKeyboardFocusInControls() {
  const active = document.activeElement;
  return active instanceof Element && active.matches(':focus-visible') && Boolean(active.closest('.reader-chrome, [data-reader-controls]'));
}

export function useReaderControls(initialVisible = true, isAutoHidePaused = false, autoHideDelayMs = DEFAULT_AUTO_HIDE_DELAY_MS) {
  const [isControlsVisible, setIsControlsVisible] = useState(initialVisible);
  const autoHideTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const clearAutoHide = useCallback(() => {
    if (autoHideTimerRef.current !== null) {
      window.clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
  }, []);

  const scheduleAutoHide = useCallback(() => {
    clearAutoHide();
    if (isAutoHidePaused || hasKeyboardFocusInControls()) return;
    autoHideTimerRef.current = window.setTimeout(() => {
      autoHideTimerRef.current = null;
      if (!hasKeyboardFocusInControls()) setIsControlsVisible(false);
    }, autoHideDelayMs);
  }, [autoHideDelayMs, clearAutoHide, isAutoHidePaused]);

  const toggleControls = useCallback(() => {
    if (isControlsVisible) {
      clearAutoHide();
      setIsControlsVisible(false);
      return;
    }
    setIsControlsVisible(true);
    scheduleAutoHide();
  }, [clearAutoHide, isControlsVisible, scheduleAutoHide]);

  const showControls = useCallback(() => {
    setIsControlsVisible(true);
    scheduleAutoHide();
  }, [scheduleAutoHide]);

  const hideControls = useCallback(() => {
    clearAutoHide();
    // A keyboard-dismissed panel restores its opener after the render. Pointer
    // dismissal can hide immediately; keyboard dismissal must keep it focusable.
    const active = document.activeElement;
    const isReturningKeyboardFocus = isAutoHidePaused && active instanceof Element && active.matches(':focus-visible');
    if (!isReturningKeyboardFocus && !hasKeyboardFocusInControls()) setIsControlsVisible(false);
  }, [clearAutoHide, isAutoHidePaused]);

  useEffect(() => {
    if (isControlsVisible) scheduleAutoHide();
    else clearAutoHide();
    return clearAutoHide;
  }, [clearAutoHide, isControlsVisible, scheduleAutoHide]);

  useEffect(() => {
    let active = true;
    const refreshFocus = () => {
      // focusout fires before the next element receives focus.
      queueMicrotask(() => {
        if (!active) return;
        if (hasKeyboardFocusInControls()) showControls();
        else if (isControlsVisible) scheduleAutoHide();
      });
    };
    document.addEventListener('focusin', refreshFocus);
    document.addEventListener('focusout', refreshFocus);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey
        && !event.isComposing && !isControlsVisible && !isAutoHidePaused && !document.querySelector('[aria-modal="true"]')) {
        // Remove inert before the browser performs native Tab traversal, so
        // hidden controls remain reachable without a mouse or touch gesture.
        flushSync(() => showControls());
      }
      refreshFocus();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerup', refreshFocus);
    return () => {
      active = false;
      document.removeEventListener('focusin', refreshFocus);
      document.removeEventListener('focusout', refreshFocus);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerup', refreshFocus);
    };
  }, [isAutoHidePaused, isControlsVisible, scheduleAutoHide, showControls]);

  return {
    isControlsVisible,
    hideControls,
    showControls,
    toggleControls,
  };
}
