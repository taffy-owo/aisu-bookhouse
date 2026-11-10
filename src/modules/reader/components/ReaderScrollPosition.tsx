import { useLayoutEffect, useRef } from 'react';
import type { PointerEvent } from 'react';
import { getReaderScrubberViewport } from '../utils/readerScrubberViewport';
import { READER_CONTROLS_LAYOUT_EVENT } from '../utils/readerControlsLayout';

interface ReaderScrollPositionProps {
  contentKey: string;
  getScrollElement: () => HTMLElement | null;
  onDragStateChange?: (dragging: boolean) => void;
  usesDocumentScroll: boolean;
}

/** Visual feedback follows the scroll frame, independently of progress saves. */
export function ReaderScrollPosition({ contentKey, getScrollElement, onDragStateChange, usesDocumentScroll }: ReaderScrollPositionProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<{ pointerId: number; grabOffset: number } | null>(null);
  const setDragging = (dragging: boolean) => {
    if (trackRef.current) trackRef.current.dataset.readerDragging = String(dragging);
    onDragStateChange?.(dragging);
  };
  useLayoutEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    const scroll = getScrollElement();
    if (!track || !thumb || !scroll) return;
    const viewport = window.visualViewport;
    const root = track.closest('.reader-with-reading-status');
    let frame = 0;
    const update = () => {
      frame = 0;
      const adjusted = viewport && (viewport.scale !== 1 || viewport.offsetLeft !== 0 || viewport.offsetTop !== 0
        || viewport.width < window.innerWidth - 1 || viewport.height < window.innerHeight - 1);
      if (adjusted) {
        const status = root?.querySelector<HTMLElement>('.reader-reading-status');
        const dockedTop = root ? Number.parseFloat(getComputedStyle(root).getPropertyValue('--reader-layout-top-inset')) || 0 : 0;
        // Transient bars may cover the rail, but must not change its mapping
        // to the chapter, including while zoomed or above a keyboard.
        const bounds = getReaderScrubberViewport(viewport,
          dockedTop ? { top: viewport.offsetTop, bottom: viewport.offsetTop + dockedTop } : undefined,
          status?.getBoundingClientRect(),
          root?.querySelector('.reader-toc-dock')?.getBoundingClientRect().left);
        if (!bounds) { track.style.visibility = 'hidden'; return; }
        track.style.left = `${bounds.left}px`;
        track.style.right = 'auto';
        track.style.top = `${bounds.top}px`;
        track.style.bottom = 'auto';
        track.style.width = `${bounds.width}px`;
        track.style.height = `${bounds.height}px`;
        thumb.style.height = `${Math.min(52, bounds.height / 3)}px`;
        thumb.style.width = `${Math.min(5, bounds.width)}px`;
        thumb.style.right = bounds.width > 5 ? '1px' : '0';
      } else if (track.style.height) {
        for (const property of ['left', 'right', 'top', 'bottom', 'width', 'height']) track.style.removeProperty(property);
        for (const property of ['height', 'width', 'right']) thumb.style.removeProperty(property);
      }
      const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const ratio = maxScroll ? Math.min(1, Math.max(0, scroll.scrollTop / maxScroll)) : 0;
      const travel = Math.max(0, track.clientHeight - thumb.offsetHeight);
      thumb.style.transform = `translate3d(0, ${travel * ratio}px, 0)`;
      track.style.visibility = maxScroll > 1 ? '' : 'hidden';
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const target = usesDocumentScroll ? window : scroll;
    target.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    root?.addEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
    root?.addEventListener('transitionend', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(track);
    observer.observe(scroll);
    const surface = scroll.querySelector('.reader-page-surface');
    if (surface) observer.observe(surface);
    update();
    return () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag) {
        track.dataset.readerDragging = 'false';
        onDragStateChange?.(false);
      }
      if (drag && track.hasPointerCapture(drag.pointerId)) track.releasePointerCapture(drag.pointerId);
      target.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      root?.removeEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
      root?.removeEventListener('transitionend', schedule);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [contentKey, getScrollElement, onDragStateChange, usesDocumentScroll]);

  const moveToPointer = (event: PointerEvent<HTMLDivElement>) => {
    const scroll = getScrollElement();
    const thumb = thumbRef.current;
    const drag = dragRef.current;
    if (!scroll || !thumb || !drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const travel = Math.max(1, bounds.height - thumb.offsetHeight);
    const ratio = Math.min(1, Math.max(0, (event.clientY - bounds.top - drag.grabOffset) / travel));
    scroll.scrollTo({ top: ratio * Math.max(0, scroll.scrollHeight - scroll.clientHeight), behavior: 'instant' });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      aria-hidden="true"
      className="reader-scroll-position"
      ref={trackRef}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        // Let window observe the gesture so pending end/paragraph restores
        // yield to this explicit reading action.
        // Context menus, middle-click autoscroll and secondary contacts must
        // never replace the reading position or take over an existing drag.
        if (event.button !== 0 || !event.isPrimary || dragRef.current) return;
        const thumb = thumbRef.current?.getBoundingClientRect();
        if (!thumb) return;
        event.preventDefault();
        const inside = event.clientY >= thumb.top && event.clientY <= thumb.bottom;
        dragRef.current = { pointerId: event.pointerId, grabOffset: inside ? event.clientY - thumb.top : thumb.height / 2 };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        if (!inside) moveToPointer(event);
      }}
      onPointerMove={(event) => {
        // With multiple mouse buttons held, releasing the primary button is
        // a pointermove rather than pointerup. End that drag immediately.
        if (!(event.buttons & 1)) {
          endDrag(event);
          return;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) moveToPointer(event);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <span className="reader-scroll-position-thumb" ref={thumbRef} />
    </div>
  );
}
