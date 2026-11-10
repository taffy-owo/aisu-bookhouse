import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useRef } from 'react';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { queueReadingActivitySync, recordReadingActivity } from '../../reading-progress';
import { useReadingActivityTracker } from './useReadingActivityTracker';

vi.mock('react', () => ({ useEffect: vi.fn(), useRef: vi.fn() }));
vi.mock('../../reading-progress', () => ({
  queueReadingActivitySync: vi.fn(async () => undefined), recordReadingActivity: vi.fn(),
}));

beforeEach(() => { vi.mocked(useRef).mockImplementation((initial) => ({ current: initial })); });
afterEach(() => {
  clearAuthStorage();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('reading activity teardown', () => {
  function environment() {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval, clearInterval }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
  }
  function useTestTracker(active: boolean) {
    useReadingActivityTracker(active, 'book');
    return vi.mocked(useEffect).mock.calls.at(-1)![0]();
  }
  it('carries fractions across readable pauses without counting loading', () => {
    environment();
    vi.mocked(useRef).mockReturnValue({ current: null });
    const first = useTestTracker(true); vi.advanceTimersByTime(400); if (typeof first === 'function') first();
    useTestTracker(false); vi.advanceTimersByTime(10_000);
    const second = useTestTracker(true); vi.advanceTimersByTime(700); if (typeof second === 'function') second();
    expect(recordReadingActivity).toHaveBeenCalledTimes(1);
    expect(recordReadingActivity).toHaveBeenCalledWith(1, expect.any(Date), 'book', JSON.stringify('a'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pauses a cached page on pagehide and resumes on pageshow', () => {
    environment(); const cleanup = useTestTracker(true); vi.advanceTimersByTime(3000);
    window.dispatchEvent(new Event('pagehide')); vi.advanceTimersByTime(30_000);
    window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(2000);
    if (typeof cleanup === 'function') cleanup();
    expect(vi.mocked(recordReadingActivity).mock.calls.map(([seconds]) => seconds)).toEqual([3, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not discard elapsed time on duplicate visible notifications', () => {
    environment(); const cleanup = useTestTracker(true); vi.advanceTimersByTime(3000);
    document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(2000);
    if (typeof cleanup === 'function') cleanup();
    expect(recordReadingActivity).toHaveBeenCalledWith(5, expect.any(Date), 'book', JSON.stringify('a'));
  });
  it.each([false, true])('persists the tail under the original account even after switching (switched=%s)', (switched) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval, clearInterval }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    useReadingActivityTracker(true, 'private-book-a');
    const cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    vi.advanceTimersByTime(10_000);
    if (switched) setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
    if (typeof cleanup === 'function') cleanup();
    expect(recordReadingActivity).toHaveBeenCalledTimes(1);
    expect(queueReadingActivitySync).toHaveBeenCalledTimes(1);
    expect(recordReadingActivity).toHaveBeenCalledWith(10, expect.any(Date), 'private-book-a', JSON.stringify('a'));
    expect(queueReadingActivitySync).toHaveBeenCalledWith(10, expect.any(Date), 'private-book-a', { keepalive: true, accountScope: JSON.stringify('a') });
    expect(vi.getTimerCount()).toBe(0);
  });
});
