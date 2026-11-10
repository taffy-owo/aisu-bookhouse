import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { observeReaderAudiobookPlayer } from '../utils/readerAudiobookPlayer';
import { READER_CONTROLS_LAYOUT_EVENT } from '../utils/readerControlsLayout';

interface ReaderChromeLayoutOptions {
  contentKey?: string;
  enabled: boolean;
  hasAudiobook?: boolean;
  isTopDocked: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  shellRef: RefObject<HTMLElement | null>;
  usesDocumentScroll: boolean;
}

/** Bars own screen space; native document scrolling keeps its browser gestures. */
export function useReaderChromeLayout({ contentKey = '', enabled, hasAudiobook = false, isTopDocked, rootRef, shellRef, usesDocumentScroll }: ReaderChromeLayoutOptions) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const shell = shellRef.current;
    if (!enabled || !root || !shell) return;
    const header = root.querySelector<HTMLElement>('.reader-chrome-top');
    const bottomBar = root.querySelector<HTMLElement>('.reader-bottom-bar');
    const status = root.querySelector<HTMLElement>('.reader-reading-status');
    let player: HTMLElement | null = null;
    const surface = shell.querySelector<HTMLElement>('.reader-page-surface');
    const prose = shell.querySelector<HTMLElement>('.reader-body-text');
    let frame = 0;
    const update = () => {
      frame = 0;
      // Player placement follows painted controls. Transient controls never
      // change the reading surface itself, including while they fade out.
      const paintsHeader = header && getComputedStyle(header).visibility === 'visible';
      const top = paintsHeader ? header?.getBoundingClientRect().height ?? 0 : 0;
      const statusHeight = status?.getBoundingClientRect().height ?? 26;
      // The toolbar floats over the reading surface and is hidden most of the
      // time. Reserving its full hidden height exposes the page's dark shell
      // above the actual bottom status strip. The article already carries its
      // own final-line padding, so only the always-visible status strip owns
      // layout space.
      const reservedBottom = statusHeight;
      root.style.setProperty('--reader-top-inset', `${top}px`);
      root.style.setProperty('--reader-bottom-inset', `${reservedBottom}px`);
      // Transient controls must never resize the page or snap a chapter back
      // to its end. Only the always-docked desktop header owns layout space.
      const dockedHeight = Number.parseFloat(header?.dataset.readerBarLayoutHeight ?? '') || top;
      root.style.setProperty('--reader-layout-top-inset', `${isTopDocked ? dockedHeight : 0}px`);
      root.style.setProperty('--reader-layout-bottom-inset', `${reservedBottom}px`);
      root.dataset.readerLayoutReady = 'true';
      // Re-clipping the whole scrolling layer during a reveal exposes its
      // backdrop and invalidates text painting. The solid bars cover it.
      shell.style.clipPath = '';
      // Add only the missing scroll room after the final line. Paragraph
      // positions stay unchanged when the floating player opens or moves.
      if (!hasAudiobook) {
        root.style.setProperty('--reader-audiobook-tail-space', '0px');
      } else if (document.body.style.position !== 'fixed') {
        const scroller = usesDocumentScroll ? document.scrollingElement : shell;
        const oldTail = Number.parseFloat(root.style.getPropertyValue('--reader-audiobook-tail-space')) || 0;
        const reservedPlayerTop = Number.parseFloat(player?.dataset.readerPlayerReservedTop ?? '');
        const playerTop = Number.isFinite(reservedPlayerTop) ? reservedPlayerTop : player?.getBoundingClientRect().top;
        const baseMax = scroller ? scroller.scrollHeight - scroller.clientHeight - oldTail : 0;
        const tail = playerTop !== undefined && scroller && surface && prose
          ? Math.ceil(Math.max(0, scroller.scrollTop + prose.getBoundingClientRect().bottom - baseMax - (playerTop - 12))) : 0;
        if (tail !== oldTail) root.style.setProperty('--reader-audiobook-tail-space', `${tail}px`);
      }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const handleChromeTransition = (event: TransitionEvent) => {
      if (event.target === header || event.target === bottomBar || event.target === player) schedule();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(shell);
    for (const element of root.querySelectorAll('.reader-chrome-top, .reader-bottom-bar, .reader-reading-status, .reader-page-surface')) observer.observe(element);
    const stopTrackingPlayer = observeReaderAudiobookPlayer(root, observer, (next) => {
      player = next;
      schedule();
    });
    if (usesDocumentScroll && hasAudiobook) window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    root.addEventListener('transitionend', handleChromeTransition);
    root.addEventListener('transitioncancel', handleChromeTransition);
    root.addEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
    update();
    return () => {
      stopTrackingPlayer();
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      root.removeEventListener('transitionend', handleChromeTransition);
      root.removeEventListener('transitioncancel', handleChromeTransition);
      root.removeEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
    };
  }, [contentKey, enabled, hasAudiobook, isTopDocked, rootRef, shellRef, usesDocumentScroll]);
}
