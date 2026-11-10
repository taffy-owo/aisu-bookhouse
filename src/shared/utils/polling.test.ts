import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from './polling';

describe('visibility-aware polling', () => {
  let page: EventTarget;
  let browser: EventTarget;
  let visibility: 'visible' | 'hidden';
  const stops: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    page = new EventTarget();
    browser = new EventTarget();
    Object.defineProperty(page, 'visibilityState', { get: () => visibility });
    Object.assign(browser, { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    vi.stubGlobal('document', page);
    vi.stubGlobal('window', browser);
  });

  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const show = () => { visibility = 'visible'; page.dispatchEvent(new Event('visibilitychange')); };
  const hide = () => { visibility = 'hidden'; page.dispatchEvent(new Event('visibilitychange')); };

  it('defers initial reads, interval timers and events while hidden', async () => {
    visibility = 'hidden';
    const task = vi.fn();
    stops.push(startPolling(task, { intervalMs: 4000, events: ['focus', 'jobs-changed'] }));
    browser.dispatchEvent(new Event('focus'));
    browser.dispatchEvent(new Event('jobs-changed'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('refreshes immediately on return and restarts the interval once', async () => {
    const task = vi.fn();
    stops.push(startPolling(task, { intervalMs: 4000 }));
    await vi.advanceTimersByTimeAsync(0);
    hide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('lets an active read finish and defers its queued follow-up until visible', async () => {
    let complete!: () => void;
    const task = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    stops.push(startPolling(task, { intervalMs: 4000, events: ['jobs-changed'] }));
    const signal = task.mock.calls[0][0] as AbortSignal;
    browser.dispatchEvent(new Event('jobs-changed'));
    hide();
    expect(signal.aborted).toBe(false);
    complete();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('coalesces foreground events into one follow-up without concurrent reads', async () => {
    let complete!: () => void;
    const task = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    stops.push(startPolling(task, { events: ['jobs-changed'] }));
    for (let i = 0; i < 10; i++) browser.dispatchEvent(new Event('jobs-changed'));
    expect(task).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('cleans up listeners, timers and active reads when stopped', async () => {
    const task = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    const stop = startPolling(task, { intervalMs: 4000, events: ['focus', 'jobs-changed'] });
    stops.push(stop);
    const signal = task.mock.calls[0][0] as AbortSignal;
    stop();
    expect(signal.aborted).toBe(true);
    hide(); show();
    browser.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports an event-only poller and does not duplicate visibility handling', async () => {
    const task = vi.fn();
    stops.push(startPolling(task, { immediate: false, events: ['visibilitychange', 'focus'] }));
    expect(task).not.toHaveBeenCalled();
    hide(); show();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invalidates a resumed view before its read, without invalidating periodic or change-event reads', async () => {
    const order: string[] = [];
    const onResume = vi.fn(() => { order.push('invalidate'); });
    const task = vi.fn(() => { order.push('read'); });
    const stop = startPolling(task, { onResume, intervalMs: 4000, events: ['focus', 'changed'] });
    stops.push(stop);
    await vi.advanceTimersByTimeAsync(4000);
    browser.dispatchEvent(new Event('changed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResume).not.toHaveBeenCalled();
    hide(); browser.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResume).not.toHaveBeenCalled();
    order.length = 0;
    show(); await vi.advanceTimersByTimeAsync(0);
    browser.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['invalidate', 'read', 'invalidate', 'read']);
    stop(); show(); browser.dispatchEvent(new Event('focus'));
    expect(onResume).toHaveBeenCalledTimes(2);
  });
});
