import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { useSession } from './SessionContext';
import { getRestorationSnapshot, isViewOnlyNavigation, persistNavigationSnapshots, readNavigationSnapshot, saveNavigationSnapshot } from '../shared/navigation/navigationState';

export function RouteScrollRestoration() {
  const location = useLocation();
  const action = useNavigationType();
  const { session, isLoading } = useSession();
  const previous = useRef<{ scope: string; url: string; key: string; y: number } | null>(null);

  useLayoutEffect(() => {
    const previousMode = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = previousMode; };
  }, []);

  useLayoutEffect(() => {
    if (isLoading) return;
    const scope = session?.id ?? 'anonymous';
    const url = location.pathname + location.search;
    // Reader progress is owned by the reader's document/container restoration hooks.
    if (location.pathname.startsWith('/reader/') || location.pathname === '/login') {
      previous.current = null;
      return;
    }
    const previousEntry = previous.current;
    const sameEntry = previousEntry?.scope === scope && previousEntry.key === location.key;
    const saved = (sameEntry && readNavigationSnapshot(scope, location.key, url)) || getRestorationSnapshot(scope, location, action);
    const samePage = previousEntry?.scope === scope && previousEntry.url.split('?')[0] === location.pathname;
    const viewOnly = previousEntry && samePage && action !== 'POP' && (isViewOnlyNavigation(previousEntry.url, url) || !['/library', '/public', '/japanese'].includes(location.pathname));
    const targetY = saved?.y ?? (viewOnly ? previous.current?.y ?? 0 : 0);
    let restoring = targetY > 0;
    let lastY = targetY;
    let frame = 0;
    let timeout = 0;
    let settledTimeout = 0;
    const record = (captureAnchor = true) => {
      if (restoring || document.body.style.position === 'fixed') return;
      lastY = window.scrollY;
      const collection = document.querySelector<HTMLElement>('[data-navigation-pages]');
      const existing = readNavigationSnapshot(scope, location.key, url);
      const pages = Number(collection?.dataset.navigationPages) || existing?.pages || 1;
      const visibleBook = captureAnchor && collection && [...collection.querySelectorAll<HTMLElement>('[data-book-id]')].find((book) => book.getBoundingClientRect().bottom > 120);
      const anchor = visibleBook ? { bookId: visibleBook.dataset.bookId!, offset: visibleBook.getBoundingClientRect().top } : undefined;
      const expandedSeriesBookId = collection?.querySelector<HTMLElement>('[data-expanded-series-book]')?.dataset.expandedSeriesBook;
      const rails = { ...existing?.rails };
      for (const rail of document.querySelectorAll<HTMLElement>('[data-navigation-rail]')) rails[rail.dataset.navigationRail!] = rail.scrollLeft;
      saveNavigationSnapshot(scope, { key: location.key, url, y: lastY, pages: Math.min(100, pages), anchor, expandedSeriesBookId, rails });
    };
    const flush = () => {
      window.clearTimeout(settledTimeout);
      record();
      persistNavigationSnapshots();
    };
    const handleScroll = () => {
      // Keep immediate numeric restoration accurate without measuring hundreds
      // of rows on each frame. Capture the book anchor after scrolling settles
      // or synchronously before a click leaves the collection.
      record(false);
      window.clearTimeout(settledTimeout);
      settledTimeout = window.setTimeout(() => record(), 120);
    };
    const handleRailScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.hasAttribute('data-navigation-rail')) record(false);
    };
    const stop = () => {
      restoring = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      observer.disconnect();
      mutations.disconnect();
    };
    const cancel = (event: Event) => {
      if (!restoring) return;
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes((event as KeyboardEvent).key)) return;
      stop();
      record();
    };
    const restore = () => {
      if (!restoring) return;
      const collection = document.querySelector<HTMLElement>('[data-navigation-pages]');
      if (document.querySelector('.app-route-fallback,[data-navigation-loading="true"]')) return;
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      const finished = !collection || collection.dataset.navigationHasMore === 'false';
      const anchor = saved?.anchor && collection && [...collection.querySelectorAll<HTMLElement>('[data-book-id]')].find((book) => book.dataset.bookId === saved.anchor?.bookId);
      const y = anchor && saved?.anchor ? window.scrollY + anchor.getBoundingClientRect().top - saved.anchor.offset : targetY;
      if (maxY < y - 2 && !finished) return;
      window.scrollTo({ top: Math.min(y, Math.max(0, maxY)), behavior: 'instant' });
      stop();
      record();
    };
    const queueRestore = () => { if (restoring) { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); } };
    const observer = new ResizeObserver(queueRestore);
    const mutations = new MutationObserver(queueRestore);
    if (restoring) {
      observer.observe(document.body);
      mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-navigation-loading', 'data-navigation-pages', 'data-navigation-has-more'] });
      queueRestore();
      timeout = window.setTimeout(() => { stop(); record(); }, 15_000);
    } else {
      window.scrollTo({ top: targetY, behavior: 'instant' });
      record();
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleRailScroll, { capture: true, passive: true });
    window.addEventListener('pagehide', flush);
    document.addEventListener('click', flush, true);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, cancel, { passive: true });
    return () => {
      previous.current = { scope, url, key: location.key, y: lastY };
      window.clearTimeout(settledTimeout);
      stop();
      observer.disconnect();
      mutations.disconnect();
      persistNavigationSnapshots();
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('scroll', handleRailScroll, true);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('click', flush, true);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(type, cancel);
    };
  }, [action, isLoading, location, session?.id]);

  return null;
}
