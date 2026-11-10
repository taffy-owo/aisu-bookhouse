import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { acknowledgeReaderStartup, stageReaderStartup, takeReaderStartup } from './readerStartupHandoff';
import type { ReaderStartup } from './readerService';
const startup = { book: { id: 'book-1' }, resource: { readerType: 'pdf' } } as ReaderStartup;
afterEach(() => { clearAuthStorage(); vi.useRealTimers(); });
describe('reader startup handoff', () => {
  it('retains startup across an aborted StrictMode effect, then consumes its successful commit', () => {
    stageReaderStartup('book-1', startup); expect(takeReaderStartup('book-1')).toBe(startup); expect(takeReaderStartup('book-1')).toBe(startup);
    acknowledgeReaderStartup('book-1', startup); expect(takeReaderStartup('book-1')).toBeNull();
  });
  it('does not give private startup data to another account', () => {
    stageReaderStartup('book-1', startup); setStoredSession({ id: 'other', nickname: 'Other', role: 'user' }); expect(takeReaderStartup('book-1')).toBeNull();
  });
  it('does not use an expired response on a later navigation', () => {
    vi.useFakeTimers(); stageReaderStartup('book-1', startup); vi.advanceTimersByTime(30001); expect(takeReaderStartup('book-1')).toBeNull();
  });
  it('does not clear another book or a newer handoff after an old commit', () => {
    stageReaderStartup('book-1', startup); expect(takeReaderStartup('book-2')).toBeNull(); const next = { ...startup }; stageReaderStartup('book-1', next);
    acknowledgeReaderStartup('book-1', startup); expect(takeReaderStartup('book-1')).toBe(next);
  });
  it.each(['comic', 'image', 'text', 'epub'] as const)('carries an acknowledged local %s position across the route switch', (readerType) => {
    const media = readerType === 'comic' || readerType === 'image';
    const server = { bookId: 'book-1', readerType, updatedAt: '2026-01-01T00:00:00Z', progressPercent: 10 };
    const resource = media
      ? { readerType, pageCount: 2, pages: [{ index: 2, positionKey: 'current', imageUrl: '/page-2' }] }
      : { readerType, chapterCount: 2, toc: [{ index: 2, positionKey: 'current', title: 'Chapter 2', progressWeight: 1 }] };
    const response = { ...startup, resource, progress: server } as ReaderStartup;
    const local = { ...server, positionKey: 'current', updatedAt: '2026-01-02T00:00:00Z', progressPercent: media ? 60 : 75,
      ...(media ? { imageIndex: 2 } : { chapterIndex: 2, epubCfi: 'aisu-scroll:0.5' }) };
    stageReaderStartup('book-1', response, local);
    const transferred = takeReaderStartup('book-1');
    expect(transferred?.progress).toBe(local);
    expect(response.progress).toBe(server);
    expect(takeReaderStartup('book-1')).toBe(transferred);
    acknowledgeReaderStartup('book-1', transferred!);
    expect(takeReaderStartup('book-1')).toBeNull();
  });
  it('keeps a newer remote reset instead of reviving a captured local position', () => {
    const response = { ...startup, resource: { readerType: 'pdf', positionKey: 'current', fileUrl: '/file.pdf' },
      progress: { bookId: 'book-1', readerType: 'pdf', progressPercent: 0, updatedAt: '2026-01-03T00:00:00Z' } } as ReaderStartup;
    stageReaderStartup('book-1', response, { ...response.progress, positionKey: 'current', pageNumber: 2, progressPercent: 60, updatedAt: '2026-01-02T00:00:00Z' });
    expect(takeReaderStartup('book-1')).toBe(response);
  });
});
