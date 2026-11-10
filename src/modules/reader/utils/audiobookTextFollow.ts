type VerticalBounds = { top: number; bottom: number };

export const AUDIOBOOK_FOLLOW_EVENT = 'aisu-reader-audiobook-follow';

/** Follow a spoken paragraph within the visible prose area, excluding reader controls. */
export function getAudiobookFollowScrollTop(target: VerticalBounds, viewport: VerticalBounds, scrollTop: number): number | null {
  const height = viewport.bottom - viewport.top;
  if (![target.top, target.bottom, viewport.top, viewport.bottom, scrollTop].every(Number.isFinite)
    || height <= 0 || target.bottom < target.top) return null;
  if (target.top >= viewport.top + height * 0.24 && target.bottom <= viewport.top + height * 0.7) return null;
  // A paragraph longer than a screen must start at its first lines. Centering
  // the entire block would skip directly into the middle of the spoken text.
  const delta = target.bottom - target.top > height
    ? target.top - viewport.top - Math.min(48, height * 0.12)
    : (target.top + target.bottom - viewport.top - viewport.bottom) / 2;
  return Math.max(0, scrollTop + delta);
}
