import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { resetApiServerClock } from '../../../shared/api/serverClock';
import { createReadingProgressTimestamp } from '../../reader/services/progressTimestamp';
import { flushReadingProgressSync, getPendingReadingProgress, queueReadingProgressSync, resetReadingProgressSyncState } from '../../reader/services/readingProgressSync';
import { setBookReadingCompletion } from './bookService';

const pending = {
  bookId: 'completion-book', readerType: 'epub' as const, progressPercent: 48,
  chapterIndex: 2, positionKey: 'chapter-2', epubCfi: 'aisu-scroll:0.45', updatedAt: '2026-10-29T10:02:00.000Z',
};
let server = { ...pending, progressPercent: 12, chapterIndex: 1, updatedAt: '2026-10-29T10:00:00.000Z' };
let paths: string[] = [];
function bookResponse() {
  return { id: pending.bookId, title: 'Book', author: 'Author', tags: [], kind: 'novel', reader_type: 'epub',
    progress_percent: server.progressPercent, updated_at: server.updatedAt, created_at: '2026-10-01T00:00:00Z',
    reading_progress: { book_id: pending.bookId, reader_type: 'epub', chapter_index: server.chapterIndex,
      chapter_href: null, epub_cfi: server.epubCfi, page_number: null, image_index: null,
      progress_percent: server.progressPercent, updated_at: server.updatedAt } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-29T10:00:00Z');
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  resetApiServerClock();
  clearAuthStorage();
  resetReadingProgressSyncState();
  paths = [];
  server = { ...pending, progressPercent: 12, chapterIndex: 1, updatedAt: '2026-10-29T10:00:00.000Z' };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
    const path = String(input);
    paths.push(path);
    const payload = JSON.parse(String(options?.body));
    if (path.endsWith('/reading-status')) {
      server.progressPercent = payload.finished ? 100 : 0;
      server.updatedAt = new Date(Math.max(Date.now(), Date.parse(server.updatedAt) + 1, Date.parse(payload.updated_at))).toISOString();
      return Response.json(bookResponse());
    }
    if (Date.parse(payload.updated_at) > Date.parse(server.updatedAt)) server = { ...server, ...payload,
      progressPercent: payload.progress_percent, chapterIndex: payload.chapter_index, updatedAt: payload.updated_at };
    return Response.json({ book_id: pending.bookId, updated_at: server.updatedAt });
  }));
});

afterEach(() => {
  resetReadingProgressSyncState();
  clearAuthStorage();
  resetApiServerClock();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('lets a reset outrank an unsent fast-clock position and its later retry', async () => {
  await queueReadingProgressSync(pending.bookId, pending);
  const result = await setBookReadingCompletion(pending.bookId, false);
  expect(result.progressPercent).toBe(0);
  expect(Date.parse(result.updatedAt)).toBeGreaterThan(Date.parse(pending.updatedAt));
  await flushReadingProgressSync(pending.bookId);
  expect(server.progressPercent).toBe(0);
  expect(paths.map(path => path.split('/').at(-1))).toEqual(['reading-status', 'progress']);
  expect(Date.parse(createReadingProgressTimestamp(undefined, pending.bookId))).toBeGreaterThan(Date.parse(result.updatedAt));
});

it('confirms the pending resume location before marking read', async () => {
  await queueReadingProgressSync(pending.bookId, pending);
  const result = await setBookReadingCompletion(pending.bookId, true);
  expect(result.progressPercent).toBe(100);
  expect(result.readingProgress).toMatchObject({ bookId: pending.bookId, chapterIndex: 2, epubCfi: pending.epubCfi, progressPercent: 100, updatedAt: result.updatedAt });
  expect(server.chapterIndex).toBe(2);
  expect(paths.map(path => path.split('/').at(-1))).toEqual(['progress', 'reading-status']);
  expect(getPendingReadingProgress(pending.bookId)).toBeNull();
});

it('returns the server resume location when initial detail progress has not arrived', async () => {
  server.chapterIndex = 2;
  const result = await setBookReadingCompletion(pending.bookId, true);
  expect(result.readingProgress).toMatchObject({ chapterIndex: 2, progressPercent: 100 });
  expect(paths).toHaveLength(1);
});

it('reports a concurrent status conflict without returning an invented completion', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ detail: '阅读进度刚在其他设备更新，请刷新后再操作。' }, { status: 409 }));
  await expect(setBookReadingCompletion(pending.bookId, false)).rejects.toMatchObject({ status: 409 });
  expect(server.progressPercent).toBe(12);
});

it('keeps an unsent resume position if its save fails before completion', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ detail: 'offline' }, { status: 503 }));
  await queueReadingProgressSync(pending.bookId, pending);
  await expect(setBookReadingCompletion(pending.bookId, true)).rejects.toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getPendingReadingProgress(pending.bookId)).toEqual(pending);
});

it('can mark a replaced edition read without reusing obsolete coordinates', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ detail: '格式已更新' }, { status: 409 }));
  await queueReadingProgressSync(pending.bookId, pending);
  expect((await setBookReadingCompletion(pending.bookId, true)).progressPercent).toBe(100);
  expect(server.chapterIndex).toBe(1);
});

it('does not send the former account completion after a late progress save', async () => {
  setStoredSession({ id: 'completion-owner', nickname: 'Owner', role: 'user' });
  await queueReadingProgressSync(pending.bookId, pending);
  let release!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const operation = setBookReadingCompletion(pending.bookId, true);
  const assertion = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  setStoredSession({ id: 'completion-other', nickname: 'Other', role: 'user' });
  release(Response.json({ book_id: pending.bookId, updated_at: pending.updatedAt }));
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(1);
});
