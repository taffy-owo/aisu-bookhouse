import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { getBooks, getBookshelfOverview, invalidateBookListCache } from '../../books/services/bookService';
import { saveReadingProgress } from './readerService';

const savedEvent = 'aisu:reading-progress-saved';
const position = { bookId: 'shelf-progress', chapterIndex: 3, readerType: 'epub' as const, progressPercent: 100, updatedAt: '2026-10-28T01:00:00Z' };

beforeEach(() => {
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  vi.stubGlobal('window', new EventTarget());
  clearAuthStorage();
  invalidateBookListCache();
});

afterEach(() => {
  invalidateBookListCache();
  clearAuthStorage();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function server() {
  let progress = 40;
  const book = () => ({ id: position.bookId, title: '灯下的来信', author: '作者', kind: 'novel', reader_type: 'epub', tags: [], progress_percent: progress, updated_at: position.updatedAt });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
    const url = String(input);
    if (url.endsWith('/progress')) {
      progress = JSON.parse(String(options?.body)).progress_percent;
      return Response.json({});
    }
    if (url.includes('/overview')) return Response.json({ items: [book()], book_labels: [], continue_book: progress < 100 ? book() : null, total: 1, favorite_count: 0, finished_count: progress === 100 ? 1 : 0, in_progress_count: progress < 100 ? 1 : 0 });
    return Response.json({ items: [book()], total: 1, page: 1, page_size: 100, has_more: false });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('reader saves and bookshelf snapshots', () => {
  it('refreshes both overview modes and the full list immediately after a confirmed save', async () => {
    server();
    await getBookshelfOverview(true);
    expect((await getBookshelfOverview(false)).books[0].progressPercent).toBe(40);
    expect((await getBooks())[0].progressPercent).toBe(40);

    await saveReadingProgress(position.bookId, position);

    const [home, profile, books] = await Promise.all([getBookshelfOverview(false), getBookshelfOverview(true), getBooks()]);
    expect(home).toMatchObject({ finishedCount: 1, inProgressCount: 0, continueBook: null });
    expect(profile.finishedCount).toBe(1);
    expect(books[0].progressPercent).toBe(100);
  });

  it('notifies an already mounted page only after the write has been confirmed', async () => {
    const fetch = server();
    const saved = vi.fn();
    window.addEventListener(savedEvent, saved);
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const save = saveReadingProgress(position.bookId, position);
    expect(saved).not.toHaveBeenCalled();
    finish(Response.json({}));
    await save;
    expect(saved).toHaveBeenCalledOnce();
  });

  it('preserves the confirmed snapshot and sends no success event on a rejected save', async () => {
    const fetch = server();
    const overview = await getBookshelfOverview(false);
    const saved = vi.fn();
    window.addEventListener(savedEvent, saved);
    fetch.mockRejectedValueOnce(new DOMException('offline', 'AbortError'));
    await expect(saveReadingProgress(position.bookId, position)).rejects.toThrow();
    expect(await getBookshelfOverview(false)).toBe(overview);
    expect(saved).not.toHaveBeenCalled();
  });

  it('does not let a pre-save overview response replace the newer cached snapshot', async () => {
    const fetch = server();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const oldRead = getBookshelfOverview(false);
    await saveReadingProgress(position.bookId, position);
    const confirmed = await getBookshelfOverview(false);
    finish(Response.json({ items: [], total: 1, favorite_count: 0, finished_count: 0, in_progress_count: 1 }));
    await oldRead;
    expect(confirmed.finishedCount).toBe(1);
    expect(await getBookshelfOverview(false)).toBe(confirmed);
  });

  it('does not refresh another account when the original save responds late', async () => {
    const fetch = server();
    setStoredSession({ id: 'reader-a', nickname: 'A', role: 'user' });
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const save = saveReadingProgress(position.bookId, position);
    setStoredSession({ id: 'reader-b', nickname: 'B', role: 'user' });
    const overview = await getBookshelfOverview(false);
    const saved = vi.fn();
    window.addEventListener(savedEvent, saved);
    finish(Response.json({}));
    await expect(save).rejects.toMatchObject({ name: 'AbortError' });
    expect(saved).not.toHaveBeenCalled();
    expect(await getBookshelfOverview(false)).toBe(overview);
  });
});
