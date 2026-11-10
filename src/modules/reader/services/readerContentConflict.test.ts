import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, clearAuthStorage, getAccountScope, setStoredSession } from '../../../shared/api';
import { notifyReaderContentConflict, readerContentConflictEvent } from './readerContentConflict';

describe('reader content conflict notifications', () => {
  let target: EventTarget;
  beforeEach(() => { target = new EventTarget(); vi.stubGlobal('window', target); clearAuthStorage(); });
  afterEach(() => { clearAuthStorage(); vi.unstubAllGlobals(); });
  it('notifies only the matching book and account', () => {
    const own = vi.fn(); const other = vi.fn();
    target.addEventListener(readerContentConflictEvent('book-1'), own);
    target.addEventListener(readerContentConflictEvent('book-2'), other);
    expect(notifyReaderContentConflict('book-1', new ApiError('changed', 409), getAccountScope())).toBe(true);
    expect(own).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled();
  });
  it('uses different event names for different accounts', () => {
    expect(readerContentConflictEvent('book', 'account-a')).not.toBe(readerContentConflictEvent('book', 'account-b'));
  });
  it('ignores a previous account confirmation', () => {
    const scope = getAccountScope(); const listener = vi.fn();
    target.addEventListener(readerContentConflictEvent('book-1', scope), listener);
    setStoredSession({ id: 'other-reader', nickname: 'Other', role: 'user' });
    expect(notifyReaderContentConflict('book-1', new ApiError('changed', 409), scope)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
  it('ignores an aborted note request', () => {
    const controller = new AbortController(); controller.abort();
    expect(notifyReaderContentConflict('book-1', new ApiError('changed', 409), getAccountScope(), controller.signal)).toBe(false);
  });
  it.each([403, 503])('does not treat status %s as a content conflict', (status) => {
    expect(notifyReaderContentConflict('book-1', new ApiError('changed', status), getAccountScope())).toBe(false);
  });
  it('does not infer a conflict from an ordinary error message', () => {
    expect(notifyReaderContentConflict('book-1', new Error('409 changed'), getAccountScope())).toBe(false);
  });
  it('does not notify without a browser window', () => {
    vi.stubGlobal('window', undefined);
    expect(notifyReaderContentConflict('book-1', new ApiError('changed', 409), getAccountScope())).toBe(false);
  });
  it('does not broadcast a conflict without a book', () => {
    expect(notifyReaderContentConflict('', new ApiError('changed', 409), getAccountScope())).toBe(false);
  });
});
