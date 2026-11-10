import { useLayoutEffect, useRef } from 'react';
import { AUDIOBOOK_LAYOUT_EVENT } from '../utils/readerAudiobookPlayer';
import { READER_CONTROLS_LAYOUT_EVENT } from '../utils/readerControlsLayout';

/** Keep floating playback controls inside the visible area, including pinch zoom. */
export function useAudiobookViewport(isOpen: boolean, isControlsVisible: boolean) {
  const playerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const player = playerRef.current;
    if (!isOpen || !player) return;
    const root = player.closest('.reader-with-reading-status');
    const header = root?.querySelector<HTMLElement>('.reader-chrome-top');
    const bottomBar = root?.querySelector<HTMLElement>('.reader-bottom-bar');
    const status = root?.querySelector<HTMLElement>('.reader-reading-status');
    const viewport = window.visualViewport;
    let frame = 0;
    let previousHeight = 0;
    let previousLayout = '';
    const update = () => {
      frame = 0;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = Math.max(1, viewport?.width ?? window.innerWidth);
      const height = Math.max(1, viewport?.height ?? window.innerHeight);
      const gap = Math.min(12, height / 8, width / 8);
      const paints = (element?: HTMLElement | null) => element && (!element.inert || getComputedStyle(element).visibility === 'visible');
      const headerBounds = paints(header) ? header!.getBoundingClientRect() : null;
      const footer = paints(bottomBar) ? bottomBar : status;
      const footerBounds = footer?.getBoundingClientRect();
      // Only reserve bars that intersect the visual viewport. A zoomed user
      // can be looking at a different part of the layout viewport entirely.
      const spaceBetweenBars = (header?: DOMRect | null, footer?: DOMRect | null) => {
        const availableTop = header && header.bottom > top && header.top < top + height
          ? Math.max(top + gap, header.bottom + gap) : top + gap;
        const availableBottom = footer && footer.bottom > top && footer.top < top + height
          ? Math.min(top + height - gap, footer.top - gap) : top + height - gap;
        // Very short viewports still need reachable controls. The player can
        // scroll internally rather than escaping above or below the screen.
        const fits = availableBottom - availableTop >= Math.min(96, height - gap * 2);
        return { top: fits ? availableTop : top + gap, bottom: fits ? availableBottom : top + height - gap };
      };
      const space = spaceBetweenBars(headerBounds, footerBounds);
      const playerWidth = Math.max(1, Math.min(672, width - gap * 2));
      player.style.width = `${playerWidth}px`;
      player.style.left = `${left + (width - playerWidth) / 2}px`;
      player.style.right = 'auto';
      player.style.bottom = 'auto';
      player.style.maxHeight = `${space.bottom - space.top}px`;
      player.style.padding = playerWidth < 280 ? '8px' : '';
      player.dataset.viewportCompact = String(playerWidth < 480);
      player.style.top = `${Math.max(space.top, space.bottom - player.getBoundingClientRect().height)}px`;
      // Reserve the same chapter tail in both control states. The player can
      // move above the toolbar without resizing the scroll range or its thumb.
      // Use natural height so internal scrolling on short screens stays stable.
      const reserved = spaceBetweenBars(header?.getBoundingClientRect(), (bottomBar ?? status)?.getBoundingClientRect());
      const naturalHeight = Math.max(player.offsetHeight, player.scrollHeight + player.offsetHeight - player.clientHeight);
      player.dataset.readerPlayerReservedTop = String(Math.max(reserved.top, reserved.bottom - naturalHeight));
      const active = document.activeElement;
      if (height < previousHeight && active instanceof HTMLElement && player.contains(active)) {
        const bounds = active.getBoundingClientRect();
        const visible = player.getBoundingClientRect();
        if (bounds.top < visible.top) player.scrollTop += bounds.top - visible.top;
        else if (bounds.bottom > visible.bottom) player.scrollTop += bounds.bottom - visible.bottom;
      }
      previousHeight = height;
      const layout = `${player.style.left}:${player.style.top}:${player.style.width}:${player.getBoundingClientRect().height}:${player.dataset.readerPlayerReservedTop}`;
      if (layout !== previousLayout) {
        previousLayout = layout;
        // Moving a fixed player does not resize it. Notify prose following
        // and trailing-space layout after the new coordinates are applied.
        player.dispatchEvent(new Event(AUDIOBOOK_LAYOUT_EVENT, { bubbles: true }));
      }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    for (const element of [player, header, bottomBar, status]) if (element) observer.observe(element);
    root?.addEventListener('transitionend', schedule);
    root?.addEventListener('transitioncancel', schedule);
    root?.addEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    update();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      root?.removeEventListener('transitionend', schedule);
      root?.removeEventListener('transitioncancel', schedule);
      root?.removeEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [isOpen, isControlsVisible]);

  return playerRef;
}
