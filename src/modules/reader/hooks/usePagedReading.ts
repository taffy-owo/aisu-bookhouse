import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { getPagedReadingLayout } from '../utils/pagedReadingLayout';
import { createPagedReadingWheel } from '../utils/pagedReadingWheel';
import { getReaderContentScrollEnd } from '../utils/readerScrollMetrics';

interface PagedReadingOptions {
  containerRef: RefObject<HTMLElement | null>;
  /** Re-measure when the chapter (or anything that changes content height) changes. */
  contentKey: string;
  enabled: boolean;
  onNextBoundary?: () => void;
  onPreviousBoundary?: () => void;
}

interface PagedReadingState {
  isAtStart: boolean;
  isAtEnd: boolean;
  currentPage: number;
  goToNextPage: () => boolean;
  goToPage: (page: number) => void;
  goToPreviousPage: () => boolean;
  pageCount: number;
}

export function usePagedReading({ containerRef, contentKey, enabled, onNextBoundary, onPreviousBoundary }: PagedReadingOptions): PagedReadingState {
  const [layout, setLayout] = useState({ currentPage: 1, pageCount: 1, isAtStart: true, isAtEnd: true });
  const turnsRef = useRef<Array<{ from: number; to: number; height: number; scrollHeight: number }>>([]);
  // Chapter loads replace the listener; the same wheel gesture can outlive it.
  const wheelMotionRef = useRef<ReturnType<typeof createPagedReadingWheel> | null>(null);
  if (wheelMotionRef.current === null) {
    wheelMotionRef.current = createPagedReadingWheel();
  }
  useEffect(() => { turnsRef.current = []; }, [contentKey]);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const layout = getReadingLayout(element);
    setLayout({ currentPage: layout.currentPage, pageCount: layout.pageCount, isAtStart: layout.isAtStart, isAtEnd: layout.isAtEnd });
  }, [containerRef]);

  const goToPage = useCallback(
    (page: number) => {
      const element = containerRef.current;
      if (!element) {
        return;
      }

      const { maxScrollTop, pageCount: totalPages, pageStep } = getReadingLayout(element);
      const targetPage = Math.min(Math.max(page, 1), totalPages);
      const targetTop = targetPage >= totalPages ? maxScrollTop : (targetPage - 1) * pageStep;
      // Page turns are discrete state changes. Smooth-scrolling an
      // overflow-hidden container is unreliable on desktop Chromium and lets
      // intermediate scroll events temporarily report the wrong page.
      element.scrollTop = targetTop;
      turnsRef.current = [];
      measure();
    },
    [containerRef, measure],
  );

  const goToNextPage = useCallback((): boolean => {
    const element = containerRef.current;
    if (!element) {
      return false;
    }

    const { maxScrollTop, pageStep } = getReadingLayout(element);
    if (element.scrollTop >= maxScrollTop - 1) {
      return false;
    }

    const from = element.scrollTop;
    element.scrollTop = Math.min(maxScrollTop, from + pageStep);
    // A partial last page is shorter than one step. Returning should restore
    // the actual page just left, including a position preserved after reflow.
    turnsRef.current.push({ from, to: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight });
    if (turnsRef.current.length > 120) turnsRef.current.shift();
    measure();
    return true;
  }, [containerRef, measure]);

  const goToPreviousPage = useCallback((): boolean => {
    const element = containerRef.current;
    if (!element) {
      return false;
    }

    const { pageStep } = getReadingLayout(element);
    if (element.scrollTop <= 1) {
      return false;
    }

    const previous = turnsRef.current.at(-1);
    if (previous && Math.abs(previous.to - element.scrollTop) <= 1 && previous.height === element.clientHeight && previous.scrollHeight === element.scrollHeight) {
      element.scrollTop = previous.from;
      turnsRef.current.pop();
    } else {
      turnsRef.current = [];
      element.scrollTop = Math.max(0, element.scrollTop - pageStep);
    }
    measure();
    return true;
  }, [containerRef, measure]);

  useEffect(() => {
    const element = containerRef.current;
    if (!enabled || !element || typeof window === 'undefined') {
      return;
    }

    measure();

    // Content height moves as chapter images load and when the layout
    // settings change; page math has to follow.
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(element);
    const contentElement = element.querySelector('.reader-content');
    if (contentElement instanceof HTMLElement) {
      resizeObserver?.observe(contentElement);
    }

    // Scroll fires per frame during the smooth page transition; measuring
    // forces layout, so coalesce to one measurement per frame at most.
    let measureFrame: number | null = null;
    const handleScroll = () => {
      if (measureFrame !== null) {
        return;
      }
      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = null;
        measure();
      });
    };
    element.addEventListener('scroll', handleScroll, { passive: true });
    // A paged desktop reader must respond to the primary mouse/trackpad
    // gesture. Overflow is intentionally hidden, so without this handler the
    // wheel appears broken and only keyboard shortcuts work.
    const handleWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey) {
        return;
      }

      event.preventDefault();
      const direction = wheelMotionRef.current?.(event, element.clientHeight, Date.now()) ?? 0;
      if (direction > 0) {
        if (!goToNextPage()) {
          onNextBoundary?.();
        }
      } else if (direction < 0) {
        if (!goToPreviousPage()) {
          onPreviousBoundary?.();
        }
      }
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('resize', measure);

    return () => {
      resizeObserver?.disconnect();
      if (measureFrame !== null) {
        window.cancelAnimationFrame(measureFrame);
      }
      element.removeEventListener('scroll', handleScroll);
      element.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', measure);
    };
  }, [containerRef, contentKey, enabled, goToNextPage, goToPreviousPage, measure, onNextBoundary, onPreviousBoundary]);

  return { ...layout, goToNextPage, goToPage, goToPreviousPage };
}

function getReadingLayout(element: HTMLElement) {
  return getPagedReadingLayout(element.scrollTop, getReaderContentScrollEnd(element) + element.clientHeight, element.clientHeight);
}
