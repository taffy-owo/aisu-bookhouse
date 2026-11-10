import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api/authTokenStore';
import { overlayProgressToBook } from './readingProgressOverlay';
import { readProgressStore, writeProgressStore } from './readingProgressStore';

const baseBook = {
  currentChapter: '待开始',
  id: 'book-1',
  progressPercent: 0,
  readerType: 'epub' as const,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('readingProgressOverlay', () => {
  it('keeps zero-percent reading history but clears it on an explicit unread reset', () => {
    const updatedAt = '2026-11-05T01:00:00Z';
    writeProgressStore({ 'book-1': { bookId: 'book-1', progressPercent: 0, chapterIndex: 2, updatedAt } });
    const reading = overlayProgressToBook(baseBook);
    expect(reading).toMatchObject({ progressPercent: 0, currentChapter: '第 2 章', lastReadAt: updatedAt });
    writeProgressStore({ 'book-1': { bookId: 'book-1', progressPercent: 0, updatedAt } });
    expect(overlayProgressToBook(reading)).toMatchObject({ progressPercent: 0, currentChapter: undefined, lastReadAt: undefined, updatedAt });
  });
  afterEach(() => {
    writeProgressStore({});
    clearAuthStorage();
    vi.unstubAllGlobals();
  });

  it('overlays chapter progress onto novel-like books', () => {
    writeProgressStore({
      'book-1': {
        bookId: 'book-1',
        chapterIndex: 5,
        progressPercent: 45,
        updatedAt: '2026-05-20T01:00:00.000Z',
      },
    });

    expect(overlayProgressToBook(baseBook)).toEqual({
      ...baseBook,
      currentChapter: '第 5 章',
      progressPercent: 45,
      updatedAt: '2026-05-20T01:00:00.000Z',
      lastReadAt: '2026-05-20T01:00:00.000Z',
    });
  });

  it('overlays image index onto comic-like books', () => {
    writeProgressStore({
      'comic-1': {
        bookId: 'comic-1',
        imageIndex: 12,
        progressPercent: 38,
        updatedAt: '2026-05-20T02:00:00.000Z',
      },
    });

    expect(
      overlayProgressToBook({
        ...baseBook,
        id: 'comic-1',
        readerType: 'comic',
      }),
    ).toMatchObject({
      currentChapter: '第 12 页',
      progressPercent: 38,
      updatedAt: '2026-05-20T02:00:00.000Z',
    });
  });

  it('keeps progress in memory when browser storage is blocked', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('storage blocked');
      },
    });

    const progress = {
      bookId: 'book-1',
      chapterIndex: 7,
      progressPercent: 64,
      updatedAt: '2026-05-20T03:00:00.000Z',
    };

    expect(() => writeProgressStore({ 'book-1': progress })).not.toThrow();
    expect(readProgressStore()).toEqual({ 'book-1': progress });
  });

  it('scopes local progress by the current user', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    setStoredSession({ id: 'user-a', nickname: 'A', role: 'user', status: 'active' });
    writeProgressStore({
      'book-1': {
        bookId: 'book-1',
        chapterIndex: 8,
        progressPercent: 80,
        updatedAt: '2026-05-21T01:00:00.000Z',
      },
    });

    setStoredSession({ id: 'user-b', nickname: 'B', role: 'user', status: 'active' });
    expect(readProgressStore()).toEqual({});

    setStoredSession({ id: 'user-a', nickname: 'A', role: 'user', status: 'active' });
    expect(readProgressStore()['book-1']?.progressPercent).toBe(80);
  });
});
