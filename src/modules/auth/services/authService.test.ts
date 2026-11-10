import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCurrentSession, getOAuthProviders, login, logout } from './authService';
import { clearAuthStorage, getAccessToken, getStoredSession, setAccessToken, setStoredSession, subscribeBeforeAccountChange } from '../../../shared/api';

describe('getCurrentSession', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    clearAuthStorage();
  });

  it('does not clear a newer login when an earlier logout finishes late', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    setAccessToken('token-a');
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    let finish!: (response: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const result = expect(logout()).rejects.toMatchObject({ name: 'AbortError' });
    setAccessToken('token-b');
    setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
    finish(new Response(null, { status: 204 }));
    await result;
    expect(getAccessToken()).toBe('token-b');
  });
  it('leaves the old credentials available while a new login flushes account-owned work', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API','true');setStoredSession({id:'login-old',nickname:'A',role:'user'});setAccessToken('old-token');
    const captures:unknown[]=[];const unsubscribe=subscribeBeforeAccountChange(()=>captures.push([getStoredSession()?.id,getAccessToken()]));
    globalThis.fetch=vi.fn().mockResolvedValue(Response.json({access_token:'new-token',token_type:'bearer',user:{id:'login-new',nickname:'B',role:'user',email:'b@example.com',status:'active'}}));
    try {await login('b@example.com','password');expect(captures).toEqual([['login-old','old-token']]);expect(getAccessToken()).toBe('new-token');expect(getStoredSession()?.id).toBe('login-new');}finally{unsubscribe()}
  });

  it('passes cancellation signals to OAuth provider discovery', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ google: true, discord: false }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(getOAuthProviders(controller.signal)).resolves.toEqual({ google: true, discord: false });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/oauth/providers', expect.objectContaining({ signal: controller.signal }));
  });

  it('passes cancellation signals to current-session reads', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const controller = new AbortController();
    setAccessToken('token-1');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ account_number: 1, email: 'a@example.com', id: 'a', nickname: 'A', role: 'user', status: 'active' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(getCurrentSession(controller.signal)).resolves.toMatchObject({ id: 'a' });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/me', expect.objectContaining({ signal: controller.signal }));
  });

  it('keeps the token and falls back to the cached session on a network error', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    setAccessToken('token-1');
    setStoredSession({ id: 'user-1', nickname: '爱素', role: 'user' });
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const session = await getCurrentSession();

    expect(session?.id).toBe('user-1');
    expect(getAccessToken()).toBe('token-1');
  });

  it('keeps the token and falls back to the cached session on a 5xx response', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    setAccessToken('token-1');
    setStoredSession({ id: 'user-1', nickname: '爱素', role: 'user' });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));

    const session = await getCurrentSession();

    expect(session?.id).toBe('user-1');
    expect(getAccessToken()).toBe('token-1');
  });

  it('clears auth storage when the backend rejects the token with 401', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    setAccessToken('token-1');
    setStoredSession({ id: 'user-1', nickname: '爱素', role: 'user' });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'token expired' }), { headers: { 'Content-Type': 'application/json' }, status: 401 }),
    );

    const session = await getCurrentSession();

    expect(session).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
