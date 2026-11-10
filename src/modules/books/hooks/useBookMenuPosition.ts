import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { getBookMenuPosition } from '../services/bookMenuPosition';

interface BookMenuOptions {
  width?: number;
  maxHeight?: number;
}

/** Follow the opener within the visual viewport and clear of persistent bars. */
export function useBookMenuPosition(
  isOpen: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  menuRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
  { width = 144, maxHeight = Infinity }: BookMenuOptions = {},
) {
  const [position, setPosition] = useState<ReturnType<typeof getBookMenuPosition> | null>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    let frame = 0;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const right = left + (viewport?.width ?? window.innerWidth);
      let top = viewport?.offsetTop ?? 0;
      let bottom = top + (viewport?.height ?? window.innerHeight);
      const header = document.querySelector('.topbar-shell')?.getBoundingClientRect();
      const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
      if (header?.height && header.top < bottom) top = Math.max(top, header.bottom);
      if (nav?.height && nav.bottom > top) bottom = Math.min(bottom, nav.top);
      if (!trigger.getClientRects().length || rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) {
        closeRef.current();
        return;
      }
      setPosition(getBookMenuPosition(rect, { left, right, top, bottom }, menu.scrollHeight + 2, { width, maxHeight }));
    };
    const schedulePosition = () => {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; updatePosition(); });
    };
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      schedulePosition();
    };
    updatePosition();
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('scroll', handleScroll, true);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedulePosition);
      window.removeEventListener('scroll', handleScroll, true);
      window.visualViewport?.removeEventListener('resize', schedulePosition);
      window.visualViewport?.removeEventListener('scroll', schedulePosition);
    };
  }, [isOpen, maxHeight, menuRef, triggerRef, width]);

  return position;
}
