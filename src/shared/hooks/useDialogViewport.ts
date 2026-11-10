import { useLayoutEffect, useRef } from 'react';

/** Fixed dialogs follow the area left visible by a keyboard or browser zoom. */
export function useDialogViewport(isOpen = true) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const element = viewportRef.current;
    if (!element) return;
    const viewport = window.visualViewport;
    let frame = 0;
    let previousHeight = 0;
    let revealFocusedField = false;
    const update = () => {
      frame = 0;
      const height = Math.max(1, viewport?.height ?? window.innerHeight);
      element.style.setProperty('--dialog-viewport-height', `${height}px`);
      element.style.setProperty('--dialog-viewport-width', `${Math.max(1, viewport?.width ?? window.innerWidth)}px`);
      element.style.setProperty('--dialog-viewport-top', `${viewport?.offsetTop ?? 0}px`);
      element.style.setProperty('--dialog-viewport-left', `${viewport?.offsetLeft ?? 0}px`);
      element.dataset.viewportCompact = String(height <= 480);
      // Resizing can hide an already-focused field without another focus
      // event. Reveal it once; viewport panning and pinch zoom remain free.
      const active = document.activeElement;
      if ((revealFocusedField || height < previousHeight) && (viewport?.scale ?? 1) === 1 && active instanceof HTMLElement
        && element.contains(active) && active.matches('input, textarea, select, [contenteditable="true"]')) {
        const bounds = active.getBoundingClientRect();
        const top = viewport?.offsetTop ?? 0;
        if (bounds.top < top || bounds.bottom > top + height) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      previousHeight = height;
      revealFocusedField = false;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const handleFocus = () => { revealFocusedField = true; schedule(); };
    update();
    element.addEventListener('focusin', handleFocus);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      element.removeEventListener('focusin', handleFocus);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [isOpen]);

  return viewportRef;
}
