import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { clearPendingReplacement, readPendingReplacement, savePendingReplacement } from './bookFileReplacementState';

afterEach(() => { clearAuthStorage(); vi.unstubAllGlobals(); });
describe('pending file replacement', () => {
  it('keeps pending tasks scoped to both the account and book', () => {
    setStoredSession({ id: 'replacement-a', nickname: 'A', role: 'user' });
    savePendingReplacement('book-a', { taskId: 'task-a', keepProgress: true });
    expect(readPendingReplacement('book-b')).toBeNull();
    setStoredSession({ id: 'replacement-b', nickname: 'B', role: 'user' });
    expect(readPendingReplacement('book-a')).toBeNull();
    setStoredSession({ id: 'replacement-a', nickname: 'A', role: 'user' });
    expect(readPendingReplacement('book-a')).toEqual({ taskId: 'task-a', keepProgress: true });
    clearPendingReplacement('book-a');
    expect(readPendingReplacement('book-a')).toBeNull();
  });

  it('loads the accepted task from browser storage after a page reload', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } });
    setStoredSession({ id: 'replacement-storage', nickname: 'A', role: 'user' });
    savePendingReplacement('stored-book', { taskId: 'task-stored', keepProgress: false });
    expect(storage.size).toBe(1);
    // Read a separately stored task to prove this does not rely on the memory map.
    const key = [...storage.keys()][0]!.replace('stored-book', 'reload-book');
    storage.set(key, JSON.stringify({ taskId: 'task-reloaded', keepProgress: true }));
    expect(readPendingReplacement('reload-book')).toEqual({ taskId: 'task-reloaded', keepProgress: true });
    clearPendingReplacement('stored-book'); clearPendingReplacement('reload-book');
    expect(storage.size).toBe(0);
  });

  it('ignores malformed browser storage', () => {
    vi.stubGlobal('window', { sessionStorage: { getItem: () => '{broken json' } });
    expect(readPendingReplacement('malformed-book')).toBeNull();
  });
});
