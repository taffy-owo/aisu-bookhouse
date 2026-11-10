import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { fetchCloudReadingActivitySummary, flushReadingActivityOutbox } from '../services/readingActivity';
import { useCloudReadingActivitySummary } from './useCloudReadingActivitySummary';

const { setState } = vi.hoisted(() => ({ setState: vi.fn() }));
vi.mock('react', () => ({
  useEffect: vi.fn(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, setState],
  useCallback: (callback: unknown) => callback,
}));
vi.mock('../services/readingActivity', () => ({
  flushReadingActivityOutbox: vi.fn(),
  fetchCloudReadingActivitySummary: vi.fn(),
  getPendingReadingActivitySummary: () => ({ eventCount: 0, seconds: 0 }),
}));

function useActivityReadHarness() {
  useCloudReadingActivitySummary('account-a');
  return vi.mocked(useEffect).mock.calls[0][0]();
}
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  setStoredSession({ id: 'account-a', nickname: 'A', role: 'user' });
});
afterEach(() => { clearAuthStorage(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('activity read ownership', () => {
  it('does not start an old page read after the shared outbox finishes for a different account', async () => {
    let finishFlush!: () => void;
    vi.mocked(flushReadingActivityOutbox).mockReturnValue(new Promise<void>((resolve) => { finishFlush = resolve; }));
    const cleanup = useActivityReadHarness();
    setStoredSession({ id: 'account-b', nickname: 'B', role: 'user' });
    finishFlush();
    await nextTick();
    expect(fetchCloudReadingActivitySummary).not.toHaveBeenCalled();
    if (typeof cleanup === 'function') cleanup();
  });

  it('does not start a page read after navigation while the durable outbox is still running', async () => {
    let finishFlush!: () => void;
    vi.mocked(flushReadingActivityOutbox).mockReturnValue(new Promise<void>((resolve) => { finishFlush = resolve; }));
    const cleanup = useActivityReadHarness();
    if (typeof cleanup === 'function') cleanup();
    finishFlush();
    await nextTick();
    expect(fetchCloudReadingActivitySummary).not.toHaveBeenCalled();
  });

  it('aborts its GET and rejects a late result after navigation', async () => {
    vi.mocked(flushReadingActivityOutbox).mockResolvedValue();
    let finishRead!: () => void;
    vi.mocked(fetchCloudReadingActivitySummary).mockReturnValue(new Promise((resolve) => { finishRead = () => resolve(null); }));
    const cleanup = useActivityReadHarness();
    await nextTick();
    const signal = vi.mocked(fetchCloudReadingActivitySummary).mock.calls[0][0];
    expect(signal?.aborted).toBe(false);
    if (typeof cleanup === 'function') cleanup();
    expect(signal?.aborted).toBe(true);
    setState.mockClear();
    finishRead();
    await nextTick();
    expect(setState).not.toHaveBeenCalled();
  });

  it('refreshes date-dependent statistics just after local midnight', async () => {
    const environment = dayScheduleEnvironment(new Date(2026, 9, 31, 23, 59, 59, 500));
    const cleanup = useDayScheduleHarness();
    await vi.advanceTimersByTimeAsync(549);
    expect(setState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    if (typeof cleanup === 'function') cleanup();
    expect(vi.getTimerCount()).toBe(0);
    environment.window.dispatchEvent(new Event('focus'));
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it('pauses the day timer while hidden and refreshes immediately when visible again', async () => {
    const environment = dayScheduleEnvironment(new Date(2026, 9, 31, 23, 59, 59, 500));
    const cleanup = useDayScheduleHarness();
    environment.visibility = 'hidden';
    environment.document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(setState).not.toHaveBeenCalled();
    environment.visibility = 'visible';
    environment.document.dispatchEvent(new Event('visibilitychange'));
    expect(setState).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    if (typeof cleanup === 'function') cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { day: '2026-03-08T05:00:00Z', hours: 23 },
    { day: '2026-11-01T04:00:00Z', hours: 25 },
  ])('schedules the next local day across a $hours-hour daylight-saving day', async ({ day, hours }) => {
    vi.stubEnv('TZ', 'America/New_York');
    dayScheduleEnvironment(new Date(day));
    const cleanup = useDayScheduleHarness();
    expect(new Date().getHours()).toBe(0);
    await vi.advanceTimersByTimeAsync(hours * 3_600_000 + 49);
    expect(setState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setState).toHaveBeenCalledTimes(1);
    if (typeof cleanup === 'function') cleanup();
  });
});

function useDayScheduleHarness() {
  useCloudReadingActivitySummary('account-a');
  return vi.mocked(useEffect).mock.calls[1][0]();
}

function dayScheduleEnvironment(now: Date) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const windowTarget = Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  const documentTarget = new EventTarget();
  const environment = { window: windowTarget, document: documentTarget, visibility: 'visible' };
  Object.defineProperty(documentTarget, 'visibilityState', { get: () => environment.visibility });
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  return environment;
}
