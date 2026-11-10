import type { ReaderResource, ReadingProgress } from '../types/reader';
import { getApiServerTime } from '../../../shared/api/serverClock';

export function getMediaProgressPercent(page: number, pageCount: number): number {
  const count = Math.floor(pageCount);
  if (!Number.isFinite(count) || count <= 0) return 0;
  const current = Math.min(count, Math.max(1, Math.floor(page) || 1));
  return current === count ? 100 : Math.min(99, Math.max(1, Math.round((current / count) * 100)));
}

export function isMediaProgressBoundToResource(progress: ReadingProgress, resource: ReaderResource): boolean {
  if (progress.readerType !== resource.readerType || progress.chapterIndex !== undefined || progress.chapterHref !== undefined || progress.epubCfi !== undefined) return false;
  if (!progress.positionKey || !Number.isFinite(progress.progressPercent) || progress.progressPercent < 0 || progress.progressPercent > 100) return false;
  if (resource.readerType === 'pdf') {
    return progress.positionKey === resource.positionKey && positiveInteger(progress.pageNumber) && progress.imageIndex === undefined;
  }
  if (resource.readerType === 'comic' || resource.readerType === 'image') {
    if (!positiveInteger(progress.imageIndex) || progress.pageNumber !== undefined) return false;
    const page = resource.pages.find((item) => item.index === progress.imageIndex);
    return Boolean(page?.imageUrl && page.positionKey === progress.positionKey);
  }
  return false;
}

/** An unsent position can win only for the same published media and a newer timestamp. */
export function resolveInitialMediaProgress(resource: ReaderResource, server: ReadingProgress, pending: ReadingProgress | null): ReadingProgress {
  if (!pending || pending.bookId !== server.bookId || !isMediaProgressBoundToResource(pending, resource)) return server;
  const localTime = Date.parse(pending.updatedAt);
  const serverTime = Date.parse(server.updatedAt);
  if (!Number.isFinite(localTime) || localTime > getApiServerTime() + 300_000 || (Number.isFinite(serverTime) && localTime <= serverTime)) return server;
  return pending;
}

/** Preserve a manually completed initial page; subsequent navigation can start a reread. */
export function shouldSaveVisibleMediaProgress(current: ReadingProgress | null, next: ReadingProgress, initial: boolean): boolean {
  if (!current || current.bookId !== next.bookId || current.readerType !== next.readerType || current.pageNumber !== next.pageNumber || current.imageIndex !== next.imageIndex) return true;
  if (current.positionKey && current.positionKey !== next.positionKey) return true;
  return initial ? current.progressPercent < next.progressPercent : current.progressPercent !== next.progressPercent;
}

type Bounds = Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right' | 'width' | 'height'>;

/** Readiness from a prefetch or a thumbnail is insufficient: the selected page must be visible. */
export function isMediaPageVisible(page: Bounds, viewport: Bounds): boolean {
  if (![page.width, page.height, viewport.width, viewport.height].every((value) => Number.isFinite(value) && value > 0)) return false;
  const width = Math.min(page.right, viewport.right) - Math.max(page.left, viewport.left);
  const height = Math.min(page.bottom, viewport.bottom) - Math.max(page.top, viewport.top);
  return width >= Math.min(page.width, viewport.width) * 0.5 && height >= Math.min(page.height, viewport.height) * 0.5;
}

function positiveInteger(value: number | undefined): boolean {
  return Number.isInteger(value) && (value ?? 0) > 0;
}
