/** Navigation controls and bottom padding are not unread chapter content. */
export function getContentScrollEnd(maxScrollTop: number, scrollTop: number, contentBottom: number, viewportBottom: number): number {
  return Math.max(0, Math.min(maxScrollTop, scrollTop + contentBottom - viewportBottom));
}

export function getContentScrollRatio(scrollTop: number, scrollEnd: number): number {
  if (scrollEnd <= 1 || scrollTop >= scrollEnd - 1) return 1;
  return Math.max(0, Math.min(1, scrollTop / scrollEnd));
}

export function getReaderContentScrollEnd(readerElement: HTMLElement): number {
  const body = readerElement.querySelector<HTMLElement>('.reader-body-text');
  const documentScroll = readerElement === document.scrollingElement;
  const documentLocked = documentScroll && document.body.style.position === 'fixed';
  const shell = body?.closest<HTMLElement>('.reader-viewport');
  const maxScrollTop = Math.max(0, (documentLocked && shell ? shell.scrollHeight : readerElement.scrollHeight) - readerElement.clientHeight);
  if (!body) return maxScrollTop;
  const scrollTop = documentLocked ? Math.max(0, -(Number.parseFloat(document.body.style.top) || 0)) : readerElement.scrollTop;
  const status = body.closest('.reader-with-reading-status')?.querySelector('.reader-reading-status');
  const layoutRoot = body.closest<HTMLElement>('.reader-with-reading-status');
  const reservedBottom = Number.parseFloat(layoutRoot ? getComputedStyle(layoutRoot).getPropertyValue('--reader-layout-bottom-inset') : '')
    || status?.getBoundingClientRect().height
    || 26;
  const viewportBottom = documentScroll
    ? window.innerHeight - reservedBottom
    : readerElement.getBoundingClientRect().bottom;
  return getContentScrollEnd(maxScrollTop, scrollTop, body.getBoundingClientRect().bottom, viewportBottom);
}
