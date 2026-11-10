import { useCallback, useEffect, useRef } from 'react';

/** Preserve ownership when disabling or removing a control sends focus to body. */
export function useFocusOwnership() {
  const ownerPathRef = useRef<EventTarget[]>([]);
  useEffect(() => {
    const remember = (event: Event) => {
      // Keep the event path: React may detach an icon from its removed button.
      if (event.target instanceof Element && event.target !== document.body && event.target !== document.documentElement) ownerPathRef.current = event.composedPath();
    };
    document.addEventListener('focusin', remember, true);
    document.addEventListener('pointerdown', remember, true);
    return () => {
      document.removeEventListener('focusin', remember, true);
      document.removeEventListener('pointerdown', remember, true);
    };
  }, []);
  return useCallback((container: Element | null) => Boolean(container && (container.contains(document.activeElement)
    || document.activeElement === document.body && ownerPathRef.current.includes(container))), []);
}
