import { updateBook } from '../../books';
import { getUploadTasks, uploadBookFile } from '../../uploads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPastedJapaneseArticleFile,
  createPastedJapaneseArticleSubmission, importPastedJapaneseArticle,
  resolvePastedJapaneseArticleTitle,
  validatePastedJapaneseArticle, waitForPastedArticleReady,
} from './pastedJapaneseArticle';

vi.mock('../../books', () => ({ invalidateBookListCache: vi.fn(), updateBook: vi.fn() }));
vi.mock('../../uploads', () => ({ getUploadTasks: vi.fn(), uploadBookFile: vi.fn() }));

describe('pastedJapaneseArticle', () => {
  it('validates Japanese body and source URL without requiring a title', () => {
    expect(validatePastedJapaneseArticle({ content: 'これは十分な長さの日文記事です。本文を貼り付けて読むための文章です。' })).toBeNull();
    expect(validatePastedJapaneseArticle({ content: 'This is not Japanese text and should be rejected.', title: 'Article' })).toContain('没有检测到日文假名');
    expect(validatePastedJapaneseArticle({ content: 'これは十分な長さの日文記事です。本文を貼り付けて読むための文章です。', sourceUrl: 'not-a-url', title: '記事' })).toBe('原文链接格式不正确');
    expect(validatePastedJapaneseArticle({ content: 'これは十分な長さの日文記事です。本文を貼り付けて読むための文章です。', sourceUrl: 'https://example.com/a', title: '記事' })).toBeNull();
  });

  it('uses a provided title or derives one from the first non-empty line', () => {
    expect(resolvePastedJapaneseArticleTitle({ content: '本文です。これは十分な長さの日文記事です。', title: '  指定した題名  ' })).toBe('指定した題名');
    expect(resolvePastedJapaneseArticleTitle({ content: '\n\n廊下に出る直前。\n背中に声がかかる。' })).toBe('廊下に出る直前。');
  });

  it('creates a safe UTF-8 txt file', async () => {
    const file = createPastedJapaneseArticleFile('悪い/題名:*?', '一行目\r\n\r\n二行目です。これは十分な本文です。');
    expect(file.name).toBe('悪い 題名.txt');
    expect(file.type).toBe('text/plain;charset=utf-8');
    expect(await file.text()).toBe('一行目\n\n二行目です。これは十分な本文です。');
  });
});

it('reuses the upload identity after a lost response', async () => {
  const input = { content: 'これは十分な長さの日文記事です。本文を貼り付けて読むための文章です。' };
  const submission = createPastedJapaneseArticleSubmission(input);
  vi.mocked(uploadBookFile).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ book_id: 'book-1', task_id: 'task-1', status: 'processing' });
  vi.mocked(getUploadTasks).mockResolvedValue([{ id: 'task-1', status: 'ready' }] as Awaited<ReturnType<typeof getUploadTasks>>);
  await expect(importPastedJapaneseArticle(input, { submission })).rejects.toThrow('Failed to fetch');
  await expect(importPastedJapaneseArticle(input, { submission })).resolves.toEqual({ bookId: 'book-1', taskId: 'task-1' });
  const calls = vi.mocked(uploadBookFile).mock.calls.slice(-2);
  expect(calls.map((call) => call[1]?.requestId)).toEqual([submission.requestId, submission.requestId]);
  expect(submission.metadataSaved).toBe(true);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('cleans up polling listeners as intervals finish and when cancelled', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const controller = new AbortController();
  vi.mocked(getUploadTasks).mockResolvedValue([]);
  const added = vi.spyOn(controller.signal, 'addEventListener');
  const removed = vi.spyOn(controller.signal, 'removeEventListener');
  const waiting = waitForPastedArticleReady('pending', controller.signal);
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(750 * 5);
  expect(added.mock.calls.length - removed.mock.calls.length).toBe(1);
  const calls = vi.mocked(getUploadTasks).mock.calls.length;
  controller.abort(); await rejected;
  expect(added.mock.calls.length - removed.mock.calls.length).toBe(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(vi.mocked(getUploadTasks).mock.calls).toHaveLength(calls);
});

it('does not report ready after cancellation during the final response', async () => {
  const controller = new AbortController();
  vi.mocked(getUploadTasks).mockImplementationOnce(async () => {
    controller.abort(); return [{ id: 'task', status: 'ready' }] as Awaited<ReturnType<typeof getUploadTasks>>;
  });
  await expect(waitForPastedArticleReady('task', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it('forwards cancellation to metadata saving and retains the uploaded receipt', async () => {
  const input = { content: 'これは十分な長さの日文記事です。本文を貼り付けて読むための文章です。' };
  const submission = createPastedJapaneseArticleSubmission(input);
  submission.receipt = { bookId: 'b', taskId: 't' };
  const controller = new AbortController();
  vi.mocked(updateBook).mockImplementationOnce(async (_id, _input, signal) => {
    controller.abort();
    signal?.throwIfAborted();
    return {} as Awaited<ReturnType<typeof updateBook>>;
  });
  await expect(importPastedJapaneseArticle(input, { submission, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(vi.mocked(updateBook).mock.calls.at(-1)?.[2]).toBe(controller.signal);
  expect(submission.receipt).toEqual({ bookId: 'b', taskId: 't' });
  expect(submission.metadataSaved).toBe(false);
  expect(submission.completed).not.toBe(true);
});
