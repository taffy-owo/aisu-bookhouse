import { useLayoutEffect, useRef } from 'react';
import { READER_CONTROLS_LAYOUT_EVENT } from '../utils/readerControlsLayout';

/** Fixed reader bars follow the part of the screen visible after zoom or a keyboard. */
export function useReaderBarViewport(edge: 'top' | 'bottom') {
  const barRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const viewport = window.visualViewport;
    let frame = 0;
    let previousLayout = '';
    if (!bar.dataset.readerBarLayoutHeight) bar.dataset.readerBarLayoutHeight = String(bar.getBoundingClientRect().height);
    const update = () => {
      frame = 0;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const width = Math.max(1, viewport?.width ?? window.innerWidth);
      const height = Math.max(1, viewport?.height ?? window.innerHeight);
      const adjusted = (viewport?.scale ?? 1) !== 1 || top !== 0 || left !== 0
        || width < window.innerWidth - 1 || height < window.innerHeight - 1 || bar.scrollHeight > height * 0.45;
      bar.dataset.readerViewportAdjusted = String(adjusted);
      if (adjusted) {
        const dock = bar.closest('.reader-has-docked-toc')?.querySelector<HTMLElement>('.reader-toc-dock');
        const dockLeft = dock?.getBoundingClientRect().left;
        const right = dockLeft !== undefined && dockLeft > left ? Math.min(left + width, dockLeft) : left + width;
        const barWidth = Math.max(1, right - left);
        bar.style.left = `${left}px`;
        bar.style.right = 'auto';
        bar.style.width = `${barWidth}px`;
        bar.style.bottom = 'auto';
        bar.style.maxHeight = `${height * 0.45}px`;
        bar.style.paddingInline = barWidth < 280 ? '8px' : '';
        bar.style.top = `${edge === 'top' ? top : top + height - bar.getBoundingClientRect().height}px`;
      } else {
        for (const property of ['left', 'right', 'width', 'bottom', 'top', 'max-height', 'padding-inline']) bar.style.removeProperty(property);
        bar.dataset.readerBarLayoutHeight = String(bar.getBoundingClientRect().height);
      }
      const bounds = bar.getBoundingClientRect();
      const layout = `${bounds.top}:${bounds.left}:${bounds.width}:${bounds.height}`;
      if (layout !== previousLayout) {
        previousLayout = layout;
        bar.dispatchEvent(new Event(READER_CONTROLS_LAYOUT_EVENT, { bubbles: true }));
      }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(bar);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    update();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [edge]);
  return barRef;
}
