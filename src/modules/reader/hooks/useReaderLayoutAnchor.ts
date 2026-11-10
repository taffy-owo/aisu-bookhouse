import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { getAccountScope } from '../../../shared/api';
import { AUDIOBOOK_FOLLOW_EVENT } from '../utils/audiobookTextFollow';
import { captureReaderViewportAnchor, restoreReaderViewportAnchor, type ReaderViewportAnchor } from '../utils/readerViewportAnchor';

interface ReaderLayoutAnchorOptions {
  contentKey: string;
  enabled: boolean;
  getScrollElement: () => HTMLElement | null;
  isPanelOpen: boolean;
  isRestoringPosition: () => boolean;
  layoutKey: string;
  onRestore: (ratio: number) => void;
  shellRef: RefObject<HTMLElement | null>;
}

export function useReaderLayoutAnchor({ contentKey, enabled, getScrollElement, isPanelOpen, isRestoringPosition, layoutKey, onRestore, shellRef }: ReaderLayoutAnchorOptions) {
  const pendingRef = useRef<{ anchor: ReaderViewportAnchor; contentKey: string; scope: string } | null>(null);
  const onRestoreRef = useRef(onRestore);
  useEffect(() => { onRestoreRef.current = onRestore; }, [onRestore]);

  const preservePosition = useCallback(() => {
    if (!enabled || pendingRef.current?.contentKey === contentKey) return;
    const shell = shellRef.current;
    const scrollElement = getScrollElement();
    if (!shell || !scrollElement) return;
    const anchor = captureReaderViewportAnchor(shell, scrollElement, 0, true);
    if (anchor) pendingRef.current = { anchor, contentKey, scope: getAccountScope() };
  }, [contentKey, enabled, getScrollElement, shellRef]);
  const isPositionPending = useCallback(() => pendingRef.current !== null, []);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.contentKey !== contentKey || pending.scope !== getAccountScope() || !enabled) {
      pendingRef.current = null;
      return;
    }
    if (isPanelOpen) return;
    let active = true;
    const startedAt = performance.now();
    let frame = 0;
    const restore = () => {
      if (!active || pending.contentKey !== contentKey || pending.scope !== getAccountScope()) return;
      const shell = shellRef.current;
      const scrollElement = getScrollElement();
      if (!shell || !scrollElement) return;
      onRestoreRef.current(restoreReaderViewportAnchor(shell, scrollElement, pending.anchor));
      pendingRef.current = null;
    };
    const scheduleRestore = () => {
      window.cancelAnimationFrame(frame);
      // Reader sheets unlock document scrolling and restore focus in their
      // cleanup; restore the paragraph after those effects finish.
      frame = window.requestAnimationFrame(restore);
    };
    const stop = (event: Event) => {
      // Escape/Enter can close a sheet and mount this effect before the same
      // key event reaches window. Only a later gesture means reading resumed.
      if (event.timeStamp <= startedAt) return;
      active = false;
      pendingRef.current = null;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.fonts?.removeEventListener('loadingdone', scheduleRestore);
      for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) window.removeEventListener(event, stop);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleRestore);
    const content = shellRef.current?.querySelector('.reader-content');
    if (content) observer?.observe(content);
    document.fonts?.addEventListener('loadingdone', scheduleRestore);
    for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) window.addEventListener(event, stop, { passive: true });
    scheduleRestore();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.fonts?.removeEventListener('loadingdone', scheduleRestore);
      for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) window.removeEventListener(event, stop);
    };
  }, [contentKey, enabled, getScrollElement, isPanelOpen, layoutKey, shellRef]);

  useEffect(() => {
    const shell = shellRef.current;
    const scrollElement = getScrollElement();
    if (!enabled || isPanelOpen || !shell || !scrollElement) return;
    let width = window.innerWidth;
    let anchor: ReaderViewportAnchor | null = null;
    let frame = 0;
    let resizing = false;
    let hasReadingGesture = false;
    let capturedScrollTop = scrollElement.scrollTop;
    let sourceTimer = 0;
    const content = shell.querySelector<HTMLElement>('.reader-body-text');
    let contentWidth = content?.offsetWidth ?? 0;
    let contentHeight = content?.offsetHeight ?? 0;
    const scope = getAccountScope();
    const isContentMounted = () => shell.isConnected && content?.isConnected && content.offsetHeight > 0;
    const capture = (source = false) => {
      if (!isContentMounted() || pendingRef.current || resizing || width !== window.innerWidth || scope !== getAccountScope()) return;
      // A scroll event caused by native anchoring can arrive before the resize
      // notification. Keep the pre-reflow anchor until that notification runs.
      if (content && (content.offsetWidth !== contentWidth || content.offsetHeight !== contentHeight)) return;
      anchor = captureReaderViewportAnchor(shell, scrollElement, anchor?.blockIndex, source);
      capturedScrollTop = scrollElement.scrollTop;
    };
    const record = () => {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; capture(); });
      window.clearTimeout(sourceTimer);
      // Character ranges are useful for delayed fonts but need not be measured
      // on every scrolling frame. Enrich the anchor once reading settles.
      sourceTimer = window.setTimeout(() => capture(true), 100);
    };
    const contentResized = () => {
      // ResizeObserver also reports a zero-size body after route teardown,
      // before passive cleanup. That must never replace valid saved progress.
      if (!content || !isContentMounted()) return;
      const changed = content.offsetWidth !== contentWidth || content.offsetHeight !== contentHeight;
      contentWidth = content.offsetWidth;
      contentHeight = content.offsetHeight;
      if (!changed || resizing || pendingRef.current || scope !== getAccountScope()) return;
      // Startup restoration owns the saved ratio until reading actually begins.
      // After that, preserve the text when an unmeasured image or translation
      // changes the chapter height, rather than relying on browser anchoring.
      if (anchor && hasReadingGesture) onRestoreRef.current(restoreReaderViewportAnchor(shell, scrollElement, anchor));
      capture(true);
    };
    const fontLoaded = () => {
      contentResized();
      if (!isContentMounted() || !anchor || !hasReadingGesture || resizing || pendingRef.current || scope !== getAccountScope()) return;
      onRestoreRef.current(restoreReaderViewportAnchor(shell, scrollElement, anchor));
      capture(true);
    };
    const resize = () => {
      // Browser bars and the on-screen keyboard change height. Only a width
      // change reflows paragraphs and needs the pre-resize reading anchor.
      if (width === window.innerWidth) return;
      width = window.innerWidth;
      window.cancelAnimationFrame(frame);
      resizing = true;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        contentWidth = content?.offsetWidth ?? 0;
        contentHeight = content?.offsetHeight ?? 0;
        if (isContentMounted() && anchor && !pendingRef.current && scope === getAccountScope()) {
          onRestoreRef.current(restoreReaderViewportAnchor(shell, scrollElement, anchor));
        }
        resizing = false;
        capture();
      });
    };
    const resumeReading = () => {
      hasReadingGesture = true;
      if (!resizing) return;
      window.cancelAnimationFrame(frame);
      frame = 0;
      resizing = false;
      anchor = null;
      record();
    };
    const target = scrollElement === document.scrollingElement ? window : scrollElement;
    const handleScroll = () => {
      // Native scrolling can lack pointer/touch/key events. It still starts
      // reading once startup has yielded and the text layout is unchanged.
      if (!hasReadingGesture && !isRestoringPosition() && isContentMounted() && anchor && !pendingRef.current && !resizing
        && width === window.innerWidth && scope === getAccountScope()
        && content?.offsetWidth === contentWidth && content.offsetHeight === contentHeight
        && Math.abs(scrollElement.scrollTop - capturedScrollTop) >= 1) hasReadingGesture = true;
      record();
    };
    target.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', resize);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(contentResized);
    if (content) observer?.observe(content);
    document.fonts?.addEventListener('loadingdone', fontLoaded);
    const gestures = ['pointerdown', 'touchstart', 'wheel', 'keydown', AUDIOBOOK_FOLLOW_EVENT];
    for (const event of gestures) window.addEventListener(event, resumeReading, { passive: true });
    record();
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(sourceTimer);
      observer?.disconnect();
      target.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', resize);
      document.fonts?.removeEventListener('loadingdone', fontLoaded);
      for (const event of gestures) window.removeEventListener(event, resumeReading);
    };
  }, [contentKey, enabled, getScrollElement, isPanelOpen, isRestoringPosition, layoutKey, shellRef]);

  return { isPositionPending, preservePosition };
}
