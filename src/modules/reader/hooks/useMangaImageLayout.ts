import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { getMangaImageSize, getMangaPageFitMode, getMangaZoomAnchor } from '../utils/mangaPageLayout';

// Measure the fit area separately from the scrollable image: zoom must not
// change its own baseline or center oversized content outside the scroll range.
export function useMangaImageLayout(stageRef: RefObject<HTMLElement | null>, identity: string, scale: number) {
  const fitAreaRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState({ identity: '', width: 0, height: 0 });
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  type Anchor = { identity: string; point: NonNullable<ReturnType<typeof getMangaZoomAnchor>> };
  const pendingAnchor = useRef<Anchor | null>(null);
  const lastAnchor = useRef<Anchor | null>(null);
  const readAnchor = useCallback((point?: { x: number; y: number }): Anchor | null => {
    const stage = stageRef.current, image = imageRef.current;
    if (!stage || !image?.isConnected || !image.naturalWidth) return null;
    const bounds = stage.getBoundingClientRect();
    const anchor = getMangaZoomAnchor(image.getBoundingClientRect(), { left: bounds.left, top: bounds.top, width: stage.clientWidth, height: stage.clientHeight }, point);
    return anchor ? { identity, point: anchor } : null;
  }, [identity, stageRef]);
  const captureZoomAnchor = useCallback((point?: { x: number; y: number }) => {
    pendingAnchor.current = readAnchor(point);
  }, [readAnchor]);

  useLayoutEffect(() => {
    const stage = stageRef.current, fit = fitAreaRef.current;
    if (!stage || !fit) return;
    let measuredWidth = -1, measuredHeight = -1;
    const measure = (preservePosition = false) => {
      const width = fit.clientWidth, height = fit.clientHeight;
      if (width === measuredWidth && height === measuredHeight) return;
      measuredWidth = width; measuredHeight = height;
      if (preservePosition && !pendingAnchor.current) pendingAnchor.current = lastAnchor.current;
      setAvailable((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    };
    const observer = new ResizeObserver(() => measure(true));
    const remember = () => {
      if (pendingAnchor.current || fit.clientWidth !== measuredWidth || fit.clientHeight !== measuredHeight) return;
      lastAnchor.current = readAnchor();
    };
    measure();
    observer.observe(fit);
    stage.addEventListener('scroll', remember, { passive: true });
    return () => { observer.disconnect(); stage.removeEventListener('scroll', remember); };
  }, [identity, readAnchor, stageRef]);

  const current = natural.identity === identity ? natural : { width: 0, height: 0 };
  const imageSize = getMangaImageSize(current.width, current.height, available.width, available.height, scale);
  const imageWidth = imageSize?.width, imageHeight = imageSize?.height;
  useLayoutEffect(() => {
    const stage = stageRef.current, image = imageRef.current, anchor = pendingAnchor.current;
    if (!stage || !image?.isConnected || imageWidth === undefined || imageHeight === undefined) return;
    pendingAnchor.current = null;
    if (anchor?.identity === identity) {
      const bounds = stage.getBoundingClientRect(), rect = image.getBoundingClientRect(), point = anchor.point;
      stage.scrollLeft += rect.left + rect.width * point.imageX - bounds.left - stage.clientWidth * point.viewportX;
      stage.scrollTop += rect.top + rect.height * point.imageY - bounds.top - stage.clientHeight * point.viewportY;
    }
    lastAnchor.current = readAnchor();
  }, [identity, imageWidth, imageHeight, available.width, available.height, readAnchor, stageRef]);

  const onImageLoad = useCallback((image: HTMLImageElement) => {
    imageRef.current = image;
    setNatural({ identity, width: image.naturalWidth, height: image.naturalHeight });
  }, [identity]);
  return { fitAreaRef, imageSize, fitMode: getMangaPageFitMode(current.width, current.height), captureZoomAnchor, onImageLoad };
}
