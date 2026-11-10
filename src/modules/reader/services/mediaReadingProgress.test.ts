import { describe, expect, it } from 'vitest';
import { getMediaProgressPercent, isMediaPageVisible, isMediaProgressBoundToResource, resolveInitialMediaProgress, shouldSaveVisibleMediaProgress } from './mediaReadingProgress';
import type { ReaderResource, ReadingProgress } from '../types/reader';

const pdf: ReaderResource = { readerType: 'pdf', positionKey: 'file-1', fileUrl: '/file.pdf' };
const comic: ReaderResource = { readerType: 'comic', pageCount: 2, pages: [{ index: 1, positionKey: 'page-1', imageUrl: '/1' }, { index: 2, positionKey: 'page-2', imageUrl: '/2' }] };
const server: ReadingProgress = { bookId: 'book', readerType: 'pdf', pageNumber: 1, progressPercent: 0, updatedAt: '2026-01-01T00:00:00Z' };
const pending: ReadingProgress = { ...server, positionKey: 'file-1', pageNumber: 2, progressPercent: 100, updatedAt: '2026-01-02T00:00:00Z' };

describe('media resume identity and time', () => {
  it('resumes a newer unsent position from the same PDF', () => expect(resolveInitialMediaProgress(pdf, server, pending)).toBe(pending));
  it.each([
    { bookId: 'another-book' }, { readerType: 'comic' as const }, { positionKey: 'another-edition' }, { positionKey: undefined },
    { pageNumber: 0 }, { pageNumber: 1.5 }, { pageNumber: undefined }, { imageIndex: 1 }, { chapterIndex: 1 }, { epubCfi: 'old-text' },
    { progressPercent: NaN }, { progressPercent: 101 }, { updatedAt: 'invalid' }, { updatedAt: '2025-12-31T00:00:00Z' }, { updatedAt: server.updatedAt },
  ])('keeps the server location for incompatible or stale pending data: %j', (change) => expect(resolveInitialMediaProgress(pdf, server, { ...pending, ...change })).toBe(server));
  it('does not trust a timestamp beyond the server clock tolerance', () => expect(resolveInitialMediaProgress(pdf, server, { ...pending, updatedAt: new Date(Date.now() + 3600_000).toISOString() })).toBe(server));
  it('resumes a keyed image ordinal without confusing it with a PDF page', () => {
    const local = { ...pending, readerType: 'comic' as const, pageNumber: undefined, imageIndex: 2, positionKey: 'page-2' };
    expect(resolveInitialMediaProgress(comic, { ...server, readerType: 'comic' }, local)).toBe(local);
    expect(isMediaProgressBoundToResource({ ...local, imageIndex: 1 }, comic)).toBe(false);
    expect(isMediaProgressBoundToResource({ ...local, imageIndex: 3 }, comic)).toBe(false);
    expect(isMediaProgressBoundToResource({ ...local, pageNumber: 2 }, comic)).toBe(false);
  });
  it('does not borrow comic positions after changing the reader format to image', () => expect(isMediaProgressBoundToResource({ ...pending, readerType: 'comic', pageNumber: undefined, imageIndex: 1, positionKey: 'page-1' }, { ...comic, readerType: 'image' })).toBe(false));
  it('does not restore a page whose media URL is unavailable', () => expect(isMediaProgressBoundToResource({ ...pending, readerType: 'comic', pageNumber: undefined, imageIndex: 1, positionKey: 'page-1' }, { ...comic, pages: [{ index: 1, positionKey: 'page-1' }] })).toBe(false));
  it('leaves text resume to its chapter history implementation', () => expect(resolveInitialMediaProgress({ readerType: 'text', toc: [], chapterCount: 0 }, server, pending)).toBe(server));
});

describe('visible media progress', () => {
  it('reserves completion for the final page even in long books', () => {
    expect(getMediaProgressPercent(199, 200)).toBe(99);
    expect(getMediaProgressPercent(999, 1000)).toBe(99);
    expect(getMediaProgressPercent(200, 200)).toBe(100);
    expect(getMediaProgressPercent(1, 1)).toBe(100);
    expect(getMediaProgressPercent(1, 0)).toBe(0);
  });
  it('saves a rendered one-page book but preserves a manual completed state on reopen', () => {
    expect(shouldSaveVisibleMediaProgress(server, { ...pending, pageNumber: 1 }, true)).toBe(true);
    expect(shouldSaveVisibleMediaProgress({ ...server, progressPercent: 100 }, { ...pending, pageNumber: 1, progressPercent: 50 }, true)).toBe(false);
    expect(shouldSaveVisibleMediaProgress({ ...server, progressPercent: 100 }, { ...pending, pageNumber: 1, progressPercent: 50 }, false)).toBe(true);
  });
  it('does not renew identical progress on zoom or chrome changes', () => expect(shouldSaveVisibleMediaProgress(pending, { ...pending, updatedAt: '2026-01-03T00:00:00Z' }, false)).toBe(false));
  it('saves a new page or file identity even at an equal percentage', () => {
    expect(shouldSaveVisibleMediaProgress(pending, { ...pending, pageNumber: 3 }, false)).toBe(true);
    expect(shouldSaveVisibleMediaProgress(pending, { ...pending, positionKey: 'new-file' }, true)).toBe(true);
  });
  const rect = (top: number, left = 0, width = 400, height = 800) => ({ top, left, width, height, bottom: top + height, right: left + width });
  it('requires the selected page to be substantially inside the reading viewport', () => {
    expect(isMediaPageVisible(rect(0), rect(0))).toBe(true);
    expect(isMediaPageVisible(rect(790), rect(0))).toBe(false);
    expect(isMediaPageVisible(rect(900), rect(0))).toBe(false);
    expect(isMediaPageVisible(rect(0, 390), rect(0))).toBe(false);
    expect(isMediaPageVisible(rect(200, 0, 400, 100), rect(0))).toBe(true);
    expect(isMediaPageVisible(rect(0, 0, 0), rect(0))).toBe(false);
  });
});
