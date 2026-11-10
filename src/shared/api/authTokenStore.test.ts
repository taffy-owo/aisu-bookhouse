import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, getAccessToken, getStoredSession, setAccessToken, setStoredSession, subscribeBeforeAccountChange } from './authTokenStore';

describe('authTokenStore', () => {
  it('flushes before both account and token are removed, without repeating after unsubscribe', () => {
    setStoredSession({ id: 'boundary-old', nickname: 'A', role: 'user' }); setAccessToken('old-token');
    const captures: unknown[] = [];
    const unsubscribe = subscribeBeforeAccountChange(() => captures.push([getStoredSession()?.id, getAccessToken()]));
    clearAuthStorage();
    expect(captures).toEqual([['boundary-old', 'old-token']]);
    unsubscribe();clearAuthStorage();expect(captures).toHaveLength(1);
  });
  it('does not stop the reader for token refresh or profile-only updates', () => {
    setStoredSession({ id: 'same-account', nickname: 'A', role: 'user' });
    const listener = vi.fn(); const unsubscribe = subscribeBeforeAccountChange(listener);
    setAccessToken('refresh-token');setStoredSession({ id: 'same-account', nickname: 'New name', role: 'user' });
    expect(listener).not.toHaveBeenCalled();
    setStoredSession({ id: 'next-account', nickname: 'B', role: 'user' });
    expect(listener).toHaveBeenCalledOnce();unsubscribe();
  });
  it('a malformed session and a failing listener cannot recurse or prevent logout', () => {
    const store = new Map<string,string>();
    vi.stubGlobal('window', {localStorage:{getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value),removeItem:(key:string)=>store.delete(key)}});
    setStoredSession({ id: 'corrupt-account', nickname: 'A', role: 'user' });
    const unsubscribe = subscribeBeforeAccountChange(() => {getStoredSession();throw new Error('cleanup failure')});
    store.set('aisu-bookhouse:session','{broken');expect(()=>clearAuthStorage()).not.toThrow();
    expect(getStoredSession()).toBeNull();unsubscribe();
  });
  afterEach(() => {
    clearAuthStorage();
    vi.unstubAllGlobals();
  });

  it('stores auth data in browser storage when available', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    setAccessToken('token-1');
    setStoredSession({ email: 'a@example.com', id: 'u1', nickname: 'Aisu', role: 'admin', status: 'active' });

    expect(getAccessToken()).toBe('token-1');
    expect(getStoredSession()).toMatchObject({ id: 'u1', role: 'admin', status: 'active' });
  });

  it('keeps auth data in memory when browser storage is blocked', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('storage blocked');
      },
    });

    expect(() => {
      setAccessToken('token-2');
      setStoredSession({ id: 'u2', nickname: 'Reader', role: 'user', status: 'active' });
    }).not.toThrow();

    expect(getAccessToken()).toBe('token-2');
    expect(getStoredSession()).toMatchObject({ id: 'u2', role: 'user', status: 'active' });
  });

  it('does not resurrect credentials removed by another tab', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    } });
    setAccessToken('old-token');
    setStoredSession({ id: 'u1', nickname: 'A', role: 'user' });
    store.clear();
    expect(getAccessToken()).toBeNull();
    expect(getStoredSession()).toBeNull();
  });

  it('retains session-only credentials when storage writes fail', () => {
    vi.stubGlobal('window', { localStorage: {
      getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('quota'); },
    } });
    setAccessToken('memory-token');
    setStoredSession({ id: 'u1', nickname: 'A', role: 'user' });
    expect(getAccessToken()).toBe('memory-token');
    expect(getStoredSession()?.id).toBe('u1');
  });
});
