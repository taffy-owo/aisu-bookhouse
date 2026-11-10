export type MangaPageFitMode = 'screen' | 'width';

// Long-strip manga pages become unreadably narrow when the whole image is
// forced into one viewport. Those pages should fill the available width and
// scroll vertically; ordinary pages continue to fit entirely on screen.
const LONG_STRIP_ASPECT_RATIO = 2.4;

export function getMangaPageFitMode(naturalWidth: number, naturalHeight: number): MangaPageFitMode {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return 'screen';
  }

  return naturalHeight / naturalWidth >= LONG_STRIP_ASPECT_RATIO ? 'width' : 'screen';
}

export function getMangaImageSize(naturalWidth: number, naturalHeight: number, availableWidth: number, availableHeight: number, scale: number) {
  if (![naturalWidth, naturalHeight, availableWidth, availableHeight, scale].every((value) => Number.isFinite(value) && value > 0)) return null;
  const ratio = naturalWidth / naturalHeight;
  const fittedWidth = getMangaPageFitMode(naturalWidth, naturalHeight) === 'width'
    ? Math.min(availableWidth, 1200)
    : Math.min(availableWidth, availableHeight * ratio);
  return { width: fittedWidth * scale, height: fittedWidth * scale / ratio };
}

export function getMangaZoomAnchor(image: { left: number; top: number; width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }, point = { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 }) {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    imageX: clamp((point.x - image.left) / image.width), imageY: clamp((point.y - image.top) / image.height),
    viewportX: clamp((point.x - viewport.left) / viewport.width), viewportY: clamp((point.y - viewport.top) / viewport.height),
  };
}
