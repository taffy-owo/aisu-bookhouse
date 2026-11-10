import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api/authTokenStore';
import { ApiError } from '../../../shared/api';
import { saveReadingProgress } from './readerService';
import {
  flushReadingProgressSync,
  flushAllReadingProgressSyncs,
  getPendingReadingProgressSyncCount,
  getPendingReadingProgress,
  getReadingProgressSyncStatus,
  queueReadingProgressSync,
  resetReadingProgressSyncState,
  resumePendingReadingProgressSyncs,
  subscribeReadingProgressSync,
} from './readingProgressSync';
import type { ReadingProgress } from '../types/reader';
import { readStoredPendingProgress } from './pendingProgressStorage';

vi.mock('./readerService', () => ({
  saveReadingProgress: vi.fn().mockResolvedValue(undefined),
}));

const saveReadingProgressMock = vi.mocked(saveReadingProgress);

describe('readingProgressSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveReadingProgressMock.mockReset();
    saveReadingProgressMock.mockResolvedValue(undefined);
    clearAuthStorage();
    resetReadingProgressSyncState();
    vi.unstubAllGlobals();
  });

  it('coalesces queued progress and saves the latest value', async () => {
    queueReadingProgressSync('book-1', createProgress(12));
    queueReadingProgressSync('book-1', createProgress(18));

    await vi.advanceTimersByTimeAsync(5000);

    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    expect(saveReadingProgressMock).toHaveBeenCalledWith('book-1', expect.objectContaining({ progressPercent: 18 }), expect.anything());
  });

  it('confirms completion without waiting for the ordinary progress deadline', async () => {
    await queueReadingProgressSync('book-1', createProgress(100));
    await vi.advanceTimersByTimeAsync(0);
    expect(saveReadingProgressMock).toHaveBeenCalledExactlyOnceWith('book-1', expect.objectContaining({ progressPercent: 100 }), expect.anything());
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it('replaces a pending partial position with immediate completion', async () => {
    await queueReadingProgressSync('book-1', createProgress(99));
    await vi.advanceTimersByTimeAsync(1000);
    await queueReadingProgressSync('book-1', createProgress(100));
    await vi.advanceTimersByTimeAsync(0);
    expect(saveReadingProgressMock).toHaveBeenCalledExactlyOnceWith('book-1', expect.objectContaining({ progressPercent: 100 }), expect.anything());
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
  });

  it('saves completion after an older request settles without sending concurrent writes', async () => {
    let complete!: () => void;
    saveReadingProgressMock.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await queueReadingProgressSync('book-1', createProgress(99));
    const previous = flushReadingProgressSync('book-1');
    await vi.advanceTimersByTimeAsync(0);
    await queueReadingProgressSync('book-1', createProgress(100));
    await vi.advanceTimersByTimeAsync(0);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    complete();
    await previous;
    await vi.advanceTimersByTimeAsync(0);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', expect.objectContaining({ progressPercent: 100 }), expect.anything());
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it('retains failed completion and respects retry backoff when the same position is queued again', async () => {
    saveReadingProgressMock.mockRejectedValueOnce(new Error('offline'));
    await queueReadingProgressSync('book-1', createProgress(100));
    await vi.advanceTimersByTimeAsync(0);
    expect(getPendingReadingProgress('book-1')?.progressPercent).toBe(100);
    await queueReadingProgressSync('book-1', createProgress(100));
    await vi.advanceTimersByTimeAsync(9999);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it('exposes a detached snapshot without allowing resume logic to mutate the queue', async () => {
    await queueReadingProgressSync('book-1', createProgress(42));
    const snapshot = getPendingReadingProgress('book-1');
    expect(snapshot?.progressPercent).toBe(42);
    snapshot!.progressPercent = 1;
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenCalledWith('book-1', expect.objectContaining({ progressPercent: 42 }), expect.anything());
    expect(getPendingReadingProgress('book-1')).toBeNull();
  });

  it('does not expose a former account position while another account is active', async () => {
    setStoredSession({ id: 'resume-owner', nickname: 'Owner', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    setStoredSession({ id: 'resume-other', nickname: 'Other', role: 'user' });
    expect(getPendingReadingProgress('book-1')).toBeNull();
    setStoredSession({ id: 'resume-owner', nickname: 'Owner', role: 'user' });
    expect(getPendingReadingProgress('book-1')?.progressPercent).toBe(42);
  });

  it('hydrates a stored snapshot before its first lookup', async () => {
    const storage = mockProgressStorage();
    storage.values.set('aisu-bookhouse:pending-reading-progress', JSON.stringify({ 'book-1': createProgress(67) }));
    expect(getPendingReadingProgress('book-1')?.progressPercent).toBe(67);
  });

  it('hydrates status immediately without notifying another component during its snapshot read', async () => {
    await Promise.resolve();
    const storage = mockProgressStorage();
    storage.values.set('aisu-bookhouse:pending-reading-progress', JSON.stringify({ 'book-1': createProgress(67) }));
    const listener = vi.fn();
    const unsubscribe = subscribeReadingProgressSync(listener);
    try {
      expect(getReadingProgressSyncStatus('book-1')).toBe('pending');
      expect(getPendingReadingProgress('book-1')?.progressPercent).toBe(67);
      expect(listener).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('persists queues synchronously and batches their status notification', async () => {
    mockProgressStorage();
    getPendingReadingProgressSyncCount();
    await Promise.resolve();
    const listener = vi.fn();
    const unsubscribe = subscribeReadingProgressSync(listener);
    try {
      void queueReadingProgressSync('book-1', createProgress(12));
      void queueReadingProgressSync('book-1', createProgress(42));
      expect(getPendingReadingProgress('book-1')?.progressPercent).toBe(42);
      expect(readStoredPendingProgress('aisu-bookhouse:pending-reading-progress').get('book-1')?.progressPercent).toBe(42);
      expect(listener).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('does not notify a reader that unmounted before a queued status update', async () => {
    getPendingReadingProgressSyncCount();
    await Promise.resolve();
    const listener = vi.fn();
    const unsubscribe = subscribeReadingProgressSync(listener);
    void queueReadingProgressSync('book-1', createProgress(42));
    unsubscribe();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it('counts unsaved books until their latest queued positions are confirmed', async () => {
    expect(getPendingReadingProgressSyncCount()).toBe(0);
    await queueReadingProgressSync('book-1', createProgress(12));
    await queueReadingProgressSync('book-2', { ...createProgress(18), bookId: 'book-2' });
    expect(getPendingReadingProgressSyncCount()).toBe(2);
    let complete!: () => void;
    saveReadingProgressMock.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    const first = flushReadingProgressSync('book-1');
    await vi.advanceTimersByTimeAsync(0);
    await queueReadingProgressSync('book-1', createProgress(24));
    complete();
    await first;
    expect(getPendingReadingProgressSyncCount()).toBe(2);
    await flushReadingProgressSync('book-1');
    await flushReadingProgressSync('book-2');
    expect(getPendingReadingProgressSyncCount()).toBe(0);
  });

  it('does not expose another account\'s pending book count', async () => {
    setStoredSession({ id: 'count-owner', nickname: 'Owner', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(12));
    expect(getPendingReadingProgressSyncCount()).toBe(1);
    setStoredSession({ id: 'other-owner', nickname: 'Other', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(0);
  });

  it('waits for every book before reporting a batch sync failure', async () => {
    const failure = new Error('First book failed');
    let complete!: () => void;
    saveReadingProgressMock.mockImplementationOnce(() => Promise.reject(failure));
    saveReadingProgressMock.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await queueReadingProgressSync('book-1', createProgress(12));
    await queueReadingProgressSync('book-2', { ...createProgress(18), bookId: 'book-2' });
    let reported: unknown;
    const sync = flushAllReadingProgressSyncs().catch((error: unknown) => { reported = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(reported).toBeUndefined();
    complete();
    await sync;
    expect(reported).toBe(failure);
    expect(getPendingReadingProgressSyncCount()).toBe(1);
  });

  it('skips duplicate progress after it has been saved', async () => {
    const progress = createProgress(42);

    queueReadingProgressSync('book-1', progress);
    await flushReadingProgressSync('book-1');
    queueReadingProgressSync('book-1', progress);
    await vi.advanceTimersByTimeAsync(5000);

    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
  });

  it('saves a new reading action at the same position after another device advances', async () => {
    const first = createProgress(42);
    let server = first;
    saveReadingProgressMock.mockImplementation(async (_bookId, progress) => {
      if (Date.parse(progress.updatedAt) > Date.parse(server.updatedAt)) server = progress;
    });
    await queueReadingProgressSync('book-1', first);
    await flushReadingProgressSync('book-1');
    server = { ...createProgress(70), updatedAt: '2026-05-24T00:01:00.000Z' };
    const reread = { ...first, updatedAt: '2026-05-24T00:02:00.000Z' };
    await queueReadingProgressSync('book-1', reread);
    await flushReadingProgressSync('book-1');
    expect(server).toEqual(reread);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
  });

  it('retains the newer action time when its coordinate is already in flight', async () => {
    mockProgressStorage();
    const first = createProgress(42);
    const reread = { ...first, updatedAt: '2026-05-24T00:02:00.000Z' };
    let complete!: () => void;
    saveReadingProgressMock.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await queueReadingProgressSync('book-1', first);
    const previous = flushReadingProgressSync('book-1');
    await vi.advanceTimersByTimeAsync(0);
    await queueReadingProgressSync('book-1', reread);
    expect(readStoredPendingProgress('aisu-bookhouse:pending-reading-progress').get('book-1')?.updatedAt).toBe(reread.updatedAt);
    complete();
    await previous;
    expect(getPendingReadingProgress('book-1')).toEqual(reread);
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', reread, expect.anything());
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
  });

  it('replaces an unsent detour when the reader returns to the saved position', async () => {
    await queueReadingProgressSync('book-1', createProgress(42));
    await flushReadingProgressSync('book-1');
    await queueReadingProgressSync('book-1', createProgress(70));
    await queueReadingProgressSync('book-1', createProgress(42));
    await vi.advanceTimersByTimeAsync(5000);

    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it.each([false, true])('saves the return position after an in-flight detour (lost response: %s)', async (lostResponse) => {
    await queueReadingProgressSync('book-1', createProgress(42));
    await flushReadingProgressSync('book-1');
    let complete!: () => void;
    let serverPosition = 42;
    saveReadingProgressMock.mockImplementationOnce(async (_bookId, progress) => {
      await new Promise<void>((resolve) => { complete = resolve; });
      serverPosition = progress.progressPercent;
      if (lostResponse) throw new TypeError('Response connection lost after server commit');
    });
    await queueReadingProgressSync('book-1', createProgress(70));
    const detour = flushReadingProgressSync('book-1').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await queueReadingProgressSync('book-1', createProgress(42));
    complete();
    await detour;
    expect(serverPosition).toBe(70);

    saveReadingProgressMock.mockImplementationOnce(async (_bookId, progress) => {
      serverPosition = progress.progressPercent;
    });
    await flushReadingProgressSync('book-1');
    expect(serverPosition).toBe(42);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(3);
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it('resumes a persisted unsent position after a reload', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    setStoredSession({ id: 'reader-1', nickname: 'Reader', role: 'user', status: 'active' });
    store.set(
      'aisu-bookhouse:pending-reading-progress:reader-1',
      JSON.stringify({ 'book-1': createProgress(73) }),
    );

    resumePendingReadingProgressSyncs();
    await vi.advanceTimersByTimeAsync(5000);

    expect(saveReadingProgressMock).toHaveBeenCalledWith(
      'book-1',
      expect.objectContaining({ progressPercent: 73 }),
      expect.anything(),
    );
    expect(readStoredPendingProgress('aisu-bookhouse:pending-reading-progress:reader-1').size).toBe(0);
  });
  it('does not share saved-position signatures between accounts', async () => {
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    await flushReadingProgressSync('book-1');
    setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
  });

  it('discards a queued flush if the account changed before it started', async () => {
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    const flush = flushReadingProgressSync('book-1');
    setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
    await flush;
    expect(saveReadingProgressMock).not.toHaveBeenCalled();
  });

  it('keeps invalid progress for attention without retrying indefinitely', async () => {
    saveReadingProgressMock.mockRejectedValue(new ApiError('无效时间', 422));
    queueReadingProgressSync('book-1', createProgress(42));
    expect(getReadingProgressSyncStatus('book-1')).toBe('pending');

    await expect(flushReadingProgressSync('book-1')).rejects.toThrow('无效时间');
    expect(getReadingProgressSyncStatus('book-1')).toBe('needs-attention');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);

    queueReadingProgressSync('book-1', createProgress(43));
    expect(getReadingProgressSyncStatus('book-1')).toBe('pending');
    await flushReadingProgressSync('book-1').catch(() => undefined);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
  });

  it('retries temporary failures and reports synced after recovery', async () => {
    saveReadingProgressMock.mockRejectedValueOnce(new ApiError('暂时不可用', 503));
    queueReadingProgressSync('book-1', createProgress(42));
    await expect(flushReadingProgressSync('book-1')).rejects.toThrow('暂时不可用');
    expect(getReadingProgressSyncStatus('book-1')).toBe('pending');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it.each([422, 503])('does not apply an old %s failure to a newer queued position', async (status) => {
    let rejectSave!: (error: Error) => void;
    saveReadingProgressMock.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    await queueReadingProgressSync('book-1', createProgress(12));
    const first = flushReadingProgressSync('book-1').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await queueReadingProgressSync('book-1', createProgress(18));
    rejectSave(new ApiError('Old request failed', status));
    await first;

    expect(getReadingProgressSyncStatus('book-1')).toBe('pending');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', expect.objectContaining({ progressPercent: 18 }), expect.anything());
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending deadline when an in-flight save already matches the latest position', async () => {
    let complete!: () => void;
    saveReadingProgressMock.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await queueReadingProgressSync('book-1', createProgress(12));
    const first = flushReadingProgressSync('book-1');
    await vi.advanceTimersByTimeAsync(0);
    await queueReadingProgressSync('book-1', createProgress(18));
    await queueReadingProgressSync('book-1', createProgress(12));
    complete();
    await first;

    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    await queueReadingProgressSync('book-1', createProgress(24));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
  });

  it.each(['all', 'read', 'write'] as const)('retains separate account queues when storage rejects %s access', async (mode) => {
    const storage = mockProgressStorage();
    storage.block[mode] = true;
    setStoredSession({ id: 'offline-a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    setStoredSession({ id: 'offline-b', nickname: 'B', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(0);
    await queueReadingProgressSync('book-1', createProgress(18));
    setStoredSession({ id: 'offline-a', nickname: 'A', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(1);
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', expect.objectContaining({ progressPercent: 42 }), expect.anything());
    setStoredSession({ id: 'offline-b', nickname: 'B', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(1);
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', expect.objectContaining({ progressPercent: 18 }), expect.anything());
  });

  it('does not restore stale disk positions after a quota-blocked acknowledgement', async () => {
    const storage = mockProgressStorage();
    const key = 'aisu-bookhouse:pending-reading-progress:quota-a';
    storage.values.set(key, JSON.stringify({ 'book-1': createProgress(12) }));
    setStoredSession({ id: 'quota-a', nickname: 'A', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(1);
    storage.block.write = true;
    await queueReadingProgressSync('book-1', createProgress(42));
    setStoredSession({ id: 'quota-b', nickname: 'B', role: 'user' });
    getPendingReadingProgressSyncCount();
    setStoredSession({ id: 'quota-a', nickname: 'A', role: 'user' });
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', expect.objectContaining({ progressPercent: 42 }), expect.anything());
    setStoredSession({ id: 'quota-b', nickname: 'B', role: 'user' });
    getPendingReadingProgressSyncCount();
    storage.block.write = false;
    setStoredSession({ id: 'quota-a', nickname: 'A', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(0);
    await flushAllReadingProgressSyncs();
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
  });

  it('merges newly stored books while keeping newer memory-only positions', async () => {
    const storage = mockProgressStorage();
    const key = 'aisu-bookhouse:pending-reading-progress:merge-a';
    setStoredSession({ id: 'merge-a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(12));
    storage.block.write = true;
    await queueReadingProgressSync('book-1', createProgress(42));
    setStoredSession({ id: 'merge-b', nickname: 'B', role: 'user' });
    getPendingReadingProgressSyncCount();
    storage.values.set(key, JSON.stringify({ 'book-1': createProgress(12), 'book-2': { ...createProgress(18), bookId: 'book-2' } }));
    storage.block.write = false;
    setStoredSession({ id: 'merge-a', nickname: 'A', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(2);
    await flushAllReadingProgressSyncs();
    expect(saveReadingProgressMock.mock.calls.map(([book, progress]) => [book, progress.progressPercent])).toEqual([['book-1', 42], ['book-2', 18]]);
    expect(readStoredPendingProgress(key).size).toBe(0);
  });

  it('keeps a returning account behind its older in-flight request', async () => {
    const storage = mockProgressStorage();
    storage.block.all = true;
    let complete!: () => void;
    saveReadingProgressMock.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    setStoredSession({ id: 'flight-a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(12));
    const first = flushReadingProgressSync('book-1');
    await vi.advanceTimersByTimeAsync(0);
    setStoredSession({ id: 'flight-b', nickname: 'B', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(8));
    setStoredSession({ id: 'flight-a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(18));
    const latest = flushReadingProgressSync('book-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    complete();
    await Promise.all([first, latest]);
    expect(saveReadingProgressMock.mock.calls.map(([, progress]) => progress.progressPercent)).toEqual([12, 18]);
    setStoredSession({ id: 'flight-b', nickname: 'B', role: 'user' });
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', expect.objectContaining({ progressPercent: 8 }), expect.anything());
  });

  it('pauses inactive account timers without losing their positions', async () => {
    const storage = mockProgressStorage();
    storage.block.all = true;
    setStoredSession({ id: 'timer-a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    setStoredSession({ id: 'timer-b', nickname: 'B', role: 'user' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saveReadingProgressMock).not.toHaveBeenCalled();
    setStoredSession({ id: 'timer-a', nickname: 'A', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveReadingProgressMock).toHaveBeenLastCalledWith('book-1', expect.objectContaining({ progressPercent: 42 }), expect.anything());
  });

  it('keeps attention-only records paused after account switching', async () => {
    const storage = mockProgressStorage();
    storage.block.all = true;
    saveReadingProgressMock.mockRejectedValueOnce(new ApiError('Invalid progress', 422));
    setStoredSession({ id: 'attention-a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    await flushReadingProgressSync('book-1').catch(() => {});
    setStoredSession({ id: 'attention-b', nickname: 'B', role: 'user' });
    getPendingReadingProgressSyncCount();
    setStoredSession({ id: 'attention-a', nickname: 'A', role: 'user' });
    expect(getReadingProgressSyncStatus('book-1')).toBe('needs-attention');
    resumePendingReadingProgressSyncs();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    await flushReadingProgressSync('book-1');
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it('clears retained memory queues and timers when explicitly reset', async () => {
    const storage = mockProgressStorage();
    storage.block.all = true;
    setStoredSession({ id: 'reset-a', nickname: 'A', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(42));
    setStoredSession({ id: 'reset-b', nickname: 'B', role: 'user' });
    await queueReadingProgressSync('book-1', createProgress(18));
    resetReadingProgressSyncState();
    expect(getPendingReadingProgressSyncCount()).toBe(0);
    setStoredSession({ id: 'reset-a', nickname: 'A', role: 'user' });
    expect(getPendingReadingProgressSyncCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not deduplicate identical coordinates from different chapter editions', async () => {
    await queueReadingProgressSync('book-1', { ...createProgress(20), positionKey: 'old-chapter' });
    await flushReadingProgressSync('book-1');
    await queueReadingProgressSync('book-1', { ...createProgress(20), positionKey: 'new-chapter' });
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
    expect(saveReadingProgressMock.mock.calls[1][1].positionKey).toBe('new-chapter');
  });

  it('keeps a new edition pending when an older in-flight edition is rejected', async () => {
    let reject!: (error: Error) => void;
    saveReadingProgressMock.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await queueReadingProgressSync('book-1', { ...createProgress(20), positionKey: 'old-chapter' });
    const first = flushReadingProgressSync('book-1');
    const rejected = expect(first).rejects.toThrow('changed');
    await vi.advanceTimersByTimeAsync(0);
    await queueReadingProgressSync('book-1', { ...createProgress(20), positionKey: 'new-chapter' });
    reject(new ApiError('changed', 409));
    await rejected;
    expect(getReadingProgressSyncStatus('book-1')).toBe('pending');
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock.mock.calls[1][1].positionKey).toBe('new-chapter');
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it('does not repeatedly retry an obsolete identity and accepts fresh-edition progress', async () => {
    saveReadingProgressMock.mockRejectedValueOnce(new ApiError('changed', 409));
    await queueReadingProgressSync('book-1', { ...createProgress(20), positionKey: 'old-chapter' });
    await expect(flushReadingProgressSync('book-1')).rejects.toThrow('changed');
    expect(getReadingProgressSyncStatus('book-1')).toBe('needs-attention');
    await vi.advanceTimersByTimeAsync(120000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
    await queueReadingProgressSync('book-1', { ...createProgress(20), positionKey: 'new-chapter' });
    await flushReadingProgressSync('book-1');
    expect(getReadingProgressSyncStatus('book-1')).toBe('synced');
  });

  it('does not deduplicate a recovered position from a new chapter revision at the same coordinate and reading time', async () => {
    const old = { ...createProgress(20), positionKey: 'same-chapter', contentVersion: 'old-prose' };
    await queueReadingProgressSync('book-1', old);
    await flushReadingProgressSync('book-1');
    await queueReadingProgressSync('book-1', { ...old, contentVersion: 'new-prose' });
    await flushReadingProgressSync('book-1');
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(2);
    expect(saveReadingProgressMock.mock.calls[1][1]).toMatchObject({ contentVersion: 'new-prose', updatedAt: old.updatedAt });
  });

  it('preserves a queued content revision after reloading and stops automatic retries on a stale revision', async () => {
    const { values } = mockProgressStorage();
    values.set('aisu-bookhouse:pending-reading-progress', JSON.stringify({ 'book-1': { ...createProgress(20), positionKey: 'same-chapter', contentVersion: 'old-prose' } }));
    saveReadingProgressMock.mockRejectedValueOnce(new ApiError('revised', 409));
    resumePendingReadingProgressSyncs();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveReadingProgressMock.mock.calls[0][1].contentVersion).toBe('old-prose');
    expect(getPendingReadingProgress('book-1')?.contentVersion).toBe('old-prose');
    expect(getReadingProgressSyncStatus('book-1')).toBe('needs-attention');
    await vi.advanceTimersByTimeAsync(120000);
    expect(saveReadingProgressMock).toHaveBeenCalledTimes(1);
  });

  it('preserves an offline queued chapter identity through storage hydration', async () => {
    const { values } = mockProgressStorage();
    values.set('aisu-bookhouse:pending-reading-progress', JSON.stringify({ 'book-1': { ...createProgress(20), positionKey: 'offline-chapter' } }));
    resumePendingReadingProgressSyncs();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveReadingProgressMock).toHaveBeenCalledWith('book-1', expect.objectContaining({ positionKey: 'offline-chapter' }), expect.anything());
  });

});

function mockProgressStorage() {
  const values = new Map<string, string>();
  const block = { all: false, read: false, write: false };
  const storage = {
    get length() { if (block.read) throw new Error('Read blocked'); return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem(key: string) { if (block.read && key.includes('pending-reading-progress')) throw new Error('Read blocked'); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (block.write && key.includes('pending-reading-progress')) throw new Error('Quota exceeded'); values.set(key, value); },
    removeItem(key: string) { if (block.write && key.includes('pending-reading-progress')) throw new Error('Quota exceeded'); values.delete(key); },
  };
  vi.stubGlobal('window', { get localStorage() { if (block.all) throw new Error('Storage blocked'); return storage; } });
  return { values, block };
}

function createProgress(progressPercent: number): ReadingProgress {
  return {
    bookId: 'book-1',
    chapterIndex: 1,
    epubCfi: `scroll:${progressPercent}`,
    progressPercent,
    readerType: 'epub',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}
