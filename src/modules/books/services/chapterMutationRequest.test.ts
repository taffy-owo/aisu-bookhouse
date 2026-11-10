import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, clearAuthStorage, setStoredSession } from '../../../shared/api';
import { appendBookChapter, deleteBookChapter, updateBookChapter } from './bookService';
import { getChapterMutationErrorMessage } from './chapterMutationRequest';

const revision = 'a'.repeat(64);
const result = { chapter_count: 2, deleted_index: 2, next_index: 2, index: 2, text_length: 4, title: '修订' };
const nativeFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let account = 0;
let storage: Storage;
const attemptKeys = () => Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter((key) => key.startsWith('aisu-bookhouse:chapter-mutation-attempt:'));
const requestHeaders = (index: number) => new Headers(fetchMock.mock.calls[index][1]?.headers);

beforeEach(() => {
  const values = new Map<string, string>();
  storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
    clear: () => values.clear(),
  };
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  setStoredSession({ id: `chapter-retry-${++account}`, nickname: '测试', role: 'user' });
  fetchMock = vi.fn<typeof fetch>();
  globalThis.fetch = fetchMock;
});
afterEach(() => { globalThis.fetch = nativeFetch; clearAuthStorage(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('chapter write identity', () => {
  it('reuses the original delete request and version after a lost response', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json(result));
    await expect(deleteBookChapter('retry-book', 2, undefined, revision)).rejects.toThrow('lost response');
    await expect(deleteBookChapter('retry-book', 2, undefined, revision)).resolves.toMatchObject({ chapterCount: 2 });
    expect(requestHeaders(0).get('Idempotency-Key')).toBe(requestHeaders(1).get('Idempotency-Key'));
    expect(requestHeaders(1).get('If-Match')).toBe(`"${revision}"`);
  });
  it('keeps separate identities for a changed draft and an earlier uncertain save', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ detail: 'unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(Response.json(result));
    const original = { content: '原草稿', title: '修订' };
    await expect(updateBookChapter('retry-book', 2, original, undefined, revision)).rejects.toThrow('unavailable');
    await updateBookChapter('retry-book', 2, { ...original, content: '修改过的草稿' }, undefined, revision);
    await updateBookChapter('retry-book', 2, original, undefined, revision);
    expect(requestHeaders(0).get('Idempotency-Key')).not.toBe(requestHeaders(1).get('Idempotency-Key'));
    expect(requestHeaders(0).get('Idempotency-Key')).toBe(requestHeaders(2).get('Idempotency-Key'));
  });
  it('treats a changed revision as a new operation even with the same numeric index', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json(result));
    await expect(deleteBookChapter('retry-book', 2, undefined, revision)).rejects.toThrow();
    await deleteBookChapter('retry-book', 2, undefined, 'b'.repeat(64));
    expect(requestHeaders(0).get('Idempotency-Key')).not.toBe(requestHeaders(1).get('Idempotency-Key'));
  });
  it('gives an intentional new submission a new identity after confirmation or rejection', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(Response.json({ detail: 'invalid chapter' }, { status: 422 }))
      .mockResolvedValueOnce(Response.json(result));
    await appendBookChapter('retry-book', { content: '同样正文' });
    await expect(appendBookChapter('retry-book', { content: '同样正文' })).rejects.toThrow('invalid chapter');
    await appendBookChapter('retry-book', { content: '同样正文' });
    expect(new Set([0, 1, 2].map(index => requestHeaders(index).get('Idempotency-Key'))).size).toBe(3);
  });
  it('retains an aborted request identity and isolates it from another account', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('view closed', 'AbortError')).mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(Response.json(result));
    const firstAccount = `chapter-retry-${account}`;
    await expect(deleteBookChapter('retry-book', 2, new AbortController().signal, revision)).rejects.toThrow('view closed');
    setStoredSession({ id: 'another-chapter-account', nickname: '另一个账号', role: 'user' });
    await deleteBookChapter('retry-book', 2, undefined, revision);
    setStoredSession({ id: firstAccount, nickname: '测试', role: 'user' });
    await deleteBookChapter('retry-book', 2, undefined, revision);
    expect(requestHeaders(0).get('Idempotency-Key')).not.toBe(requestHeaders(1).get('Idempotency-Key'));
    expect(requestHeaders(0).get('Idempotency-Key')).toBe(requestHeaders(2).get('Idempotency-Key'));
  });
  it('requires a loaded chapter version before saving or deleting', async () => {
    await expect(deleteBookChapter('retry-book', 2)).rejects.toThrow('章节版本缺失');
    await expect(updateBookChapter('retry-book', 2, { content: '正文' })).rejects.toThrow('章节版本缺失');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('distinguishes a rejected stale edit from an unconfirmed transport failure', () => {
    expect(getChapterMutationErrorMessage('保存', new ApiError('章节已更新，本次未执行。', 412))).toBe('章节已更新，本次未执行。');
    expect(getChapterMutationErrorMessage('保存', new TypeError('Failed to fetch'))).toContain('正文已保留，可用相同内容重试核对');
    expect(getChapterMutationErrorMessage('删除', new ApiError('timeout', 503))).toContain('可直接重试核对原操作');
  });

  it('recovers an uncertain identity after reloading the module and removes it only after confirmation', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json(result));
    await expect(appendBookChapter('reload-book', { title: '原草稿', content: '刷新后保留同一请求的正文' })).rejects.toThrow();
    expect(attemptKeys()).toHaveLength(1);
    expect(storage.getItem(attemptKeys()[0])).not.toContain('正文');
    expect(attemptKeys()[0]).not.toContain('reload-book');
    vi.resetModules();
    const reloaded = await import('./bookService');
    await reloaded.appendBookChapter('reload-book', { title: '原草稿', content: '刷新后保留同一请求的正文' });
    expect(requestHeaders(1).get('Idempotency-Key')).toBe(requestHeaders(0).get('Idempotency-Key'));
    expect(attemptKeys()).toHaveLength(0);
  });

  it('persists only a small request digest even for a large draft', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(appendBookChapter('large-draft-book', { content: '不应写进请求编号记录的正文。'.repeat(30000) })).rejects.toThrow();
    const records = attemptKeys().map((key) => key + storage.getItem(key));
    expect(records).toHaveLength(1);
    expect(records.join('')).not.toContain('正文');
    expect(records.join('').length).toBeLessThan(250);
  });

  it('retains the identity in memory when storage is blocked, then persists it when storage recovers', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const blocked = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    await expect(appendBookChapter('blocked-storage-book', { content: '原正文' })).rejects.toThrow();
    blocked.mockRestore();
    await expect(appendBookChapter('blocked-storage-book', { content: '原正文' })).rejects.toThrow();
    expect(requestHeaders(1).get('Idempotency-Key')).toBe(requestHeaders(0).get('Idempotency-Key'));
    expect(attemptKeys()).toHaveLength(1);
  });

  it('does not turn confirmed success into failure if browser locks are unavailable', async () => {
    vi.stubGlobal('navigator', { locks: { request: vi.fn().mockRejectedValue(new DOMException('blocked', 'SecurityError')) } });
    fetchMock.mockResolvedValue(Response.json(result));
    await expect(appendBookChapter('blocked-locks-book', { content: '原正文' })).resolves.toMatchObject({ chapterCount: 2 });
    expect(attemptKeys()).toHaveLength(0);
  });

  it('uses a browser lock to share the same pending identity across two module instances', async () => {
    let queue = Promise.resolve();
    const request = vi.fn((_name: string, action: () => unknown) => {
      const pending = queue.then(action);
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const first = appendBookChapter('two-tabs-book', { content: '相同正文' });
    vi.resetModules();
    const otherTab = await import('./bookService');
    const second = otherTab.appendBookChapter('two-tabs-book', { content: '相同正文' });
    await Promise.allSettled([first, second]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(requestHeaders(1).get('Idempotency-Key')).toBe(requestHeaders(0).get('Idempotency-Key'));
  });

  it('bounds persistent uncertainty records without evicting unrelated browser data', async () => {
    const prefix = 'aisu-bookhouse:chapter-mutation-attempt:';
    for (let index = 0; index < 128; index += 1) storage.setItem(prefix + String(index).padStart(64, '0'), JSON.stringify({ requestId: crypto.randomUUID(), createdAt: index }));
    storage.setItem('unrelated-draft', 'must survive');
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(appendBookChapter('bounded-attempts-book', { content: '正文' })).rejects.toThrow();
    expect(attemptKeys()).toHaveLength(128);
    expect(storage.getItem('unrelated-draft')).toBe('must survive');
  });

  it('cancels an old-account write if the account switches while awaiting a browser lock', async () => {
    let allocate: (() => unknown) | undefined;
    let release: ((value: unknown) => void) | undefined;
    let reject: ((error: unknown) => void) | undefined;
    vi.stubGlobal('navigator', { locks: { request: (_name: string, action: () => unknown) => {
      allocate = action;
      return new Promise((resolve, fail) => { release = resolve; reject = fail; });
    } } });
    const pending = appendBookChapter('scope-lock-book', { content: '旧账号正文' });
    const settled = expect(pending).rejects.toThrow('账号已切换');
    await vi.waitFor(() => expect(allocate).toBeDefined());
    setStoredSession({ id: 'switched-during-lock', nickname: '另一个账号', role: 'user' });
    try { release?.(allocate?.()); } catch (error) { reject?.(error); }
    await settled;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attemptKeys()).toHaveLength(0);
  });
});
