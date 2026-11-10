type VerticalBounds = { top: number; bottom: number };
type VisibleViewport = { offsetLeft: number; offsetTop: number; width: number; height: number };

/** The desktop scrubber belongs to the visible prose, outside the reader bars and catalogue. */
export function getReaderScrubberViewport(viewport: VisibleViewport, header?: VerticalBounds, footer?: VerticalBounds, dockLeft?: number) {
  const left = viewport.offsetLeft;
  const right = Math.min(left + viewport.width, dockLeft ?? Number.POSITIVE_INFINITY);
  const top = viewport.offsetTop;
  const bottom = top + viewport.height;
  const intersects = (bounds: VerticalBounds) => bounds.bottom > top && bounds.top < bottom;
  const trackTop = Math.max(top, header && intersects(header) ? header.bottom : top) + 3;
  const trackBottom = Math.min(bottom, footer && intersects(footer) ? footer.top : bottom) - 3;
  if (right <= left || trackBottom <= trackTop) return null;
  const width = Math.min(12, right - left);
  return { left: right - width, top: trackTop, width, height: trackBottom - trackTop };
}
