import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncExternalStore } from 'react';
import { useMediaQuery } from './useMediaQuery';

vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useSyncExternalStore: vi.fn((_subscribe: unknown, read: () => boolean) => read()),
}));

class Query extends EventTarget { matches = false; }
let queries: Map<string, Query>;
beforeEach(() => {
  queries = new Map();
  vi.stubGlobal('window', { matchMedia: (query: string) => {
    if (!queries.has(query)) queries.set(query, new Query());
    return queries.get(query)!;
  } });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('responsive state before the first paint', () => {
  it('uses the actual match immediately instead of mounting the opposite layout', () => {
    const desktop = new Query(); desktop.matches = true; queries.set('(pointer: fine)', desktop);
    expect(useMediaQuery('(pointer: fine)')).toBe(true);
    expect(useMediaQuery('(pointer: coarse)')).toBe(false);
  });
  it('reads a changed query immediately', () => {
    const touch = new Query(); touch.matches = true; queries.set('(pointer: coarse)', touch);
    expect(useMediaQuery('(pointer: fine)')).toBe(false);
    expect(useMediaQuery('(pointer: coarse)')).toBe(true);
  });
  it('subscribes to changes and removes the same subscription on cleanup', () => {
    useMediaQuery('(pointer: coarse)');
    const [subscribe, read] = vi.mocked(useSyncExternalStore).mock.calls[0];
    const changed = vi.fn(); const cleanup = subscribe(changed);
    const touch = queries.get('(pointer: coarse)')!;
    touch.matches = true; touch.dispatchEvent(new Event('change'));
    expect(changed).toHaveBeenCalledOnce(); expect(read()).toBe(true);
    cleanup(); touch.dispatchEvent(new Event('change'));
    expect(changed).toHaveBeenCalledOnce();
  });
  it('provides a stable fallback without a browser', () => {
    vi.stubGlobal('window', undefined);
    expect(useMediaQuery('(pointer: fine)')).toBe(false);
    const [subscribe, , serverSnapshot] = vi.mocked(useSyncExternalStore).mock.calls[0];
    expect(serverSnapshot?.()).toBe(false);
    expect(() => subscribe(vi.fn())()).not.toThrow();
  });
});
