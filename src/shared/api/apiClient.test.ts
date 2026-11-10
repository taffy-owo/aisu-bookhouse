import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, refreshApiSession, refreshApiSessionStatus, SESSION_EXPIRED_EVENT } from './apiClient';
import { clearAuthStorage, getAccessToken, setAccessToken, setStoredSession } from './authTokenStore';
import { changePassword } from '../../modules/auth/services/authService';

afterEach(() => {
  vi.useRealTimers();
  clearAuthStorage();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('apiRequest', () => {
  it('maps backend error codes to readable messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: { error_code: 'unsupported_format', task_id: 'task-1' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 400,
          statusText: 'Bad Request',
        }),
      ),
    );

    await expect(apiRequest('/uploads/books')).rejects.toMatchObject({
      message: '暂不支持该文件格式。',
      status: 400,
    });
  });

  it('passes request cancellation signals through to fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/books', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: 'include', signal: controller.signal }));
  });

  it('retries transient gateway failures for idempotent reads', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const request = apiRequest<{ ok: boolean }>('/books');
    await vi.advanceTimersByTimeAsync(250);

    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not retry modifying requests', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/books/book-1', { method: 'PATCH' })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refreshes an expired session and retries the original request', async () => {
    setAccessToken('expired-token');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ access_token: 'fresh-token' }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      return authorization === 'Bearer fresh-token'
        ? new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
        : new Response(JSON.stringify({ detail: 'expired' }), { headers: { 'Content-Type': 'application/json' }, status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/books')).resolves.toEqual({ ok: true });

    expect(getAccessToken()).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ credentials: 'include', method: 'POST' }));
  });

  it('deduplicates concurrent refresh requests', async () => {
    setAccessToken('expired-token');
    let refreshCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCount += 1;
        await Promise.resolve();
        return new Response(JSON.stringify({ access_token: 'fresh-token' }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      return authorization === 'Bearer fresh-token'
        ? new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
        : new Response(null, { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([apiRequest('/books'), apiRequest('/books/source-updates')]);

    expect(refreshCount).toBe(1);
  });

  it('clears the local session and emits expiry when refresh fails', async () => {
    setAccessToken('expired-token');
    setStoredSession({ id: 'user-1', nickname: '爱素', role: 'user' });
    const expiredListener = vi.fn();
    const windowTarget = Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } });
    vi.stubGlobal('window', windowTarget);
    windowTarget.addEventListener(SESSION_EXPIRED_EVENT, expiredListener, { once: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));

    await expect(apiRequest('/books')).rejects.toMatchObject({ status: 401 });

    expect(getAccessToken()).toBeNull();
    expect(expiredListener).toHaveBeenCalledOnce();
  });

  it('keeps the session when refresh is temporarily unavailable', async () => {
    setAccessToken('still-saved-token');
    setStoredSession({ id: 'user-1', nickname: '爱素', role: 'user' });
    const expiredListener = vi.fn();
    const windowTarget = Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } });
    vi.stubGlobal('window', windowTarget);
    windowTarget.addEventListener(SESSION_EXPIRED_EVENT, expiredListener);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      new Response(null, { status: String(input).endsWith('/auth/refresh') ? 502 : 401 })));

    await expect(apiRequest('/books')).rejects.toMatchObject({ status: 503 });
    expect(getAccessToken()).toBe('still-saved-token');
    expect(expiredListener).not.toHaveBeenCalled();
  });
});

it('does not restore an old refresh token after logout', async () => {
  setAccessToken('old-token');
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const refresh = refreshApiSession();
  clearAuthStorage();
  finish(new Response(JSON.stringify({ access_token: 'late-token' }), { status: 200 }));
  expect(await refresh).toBe(false);
  expect(getAccessToken()).toBeNull();
});

it('waits for the winning tab after a concurrent refresh conflict', async () => {
  vi.useFakeTimers();
  try {
    setAccessToken('old-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 409 })));
    const refresh = refreshApiSession();
    await Promise.resolve();
    setAccessToken('winner-token');
    await vi.advanceTimersByTimeAsync(50);
    expect(await refresh).toBe(true);
    expect(getAccessToken()).toBe('winner-token');
  } finally {
    vi.useRealTimers();
  }
});

it('accepts the winning tab token even when its response arrives first', async () => {
  setAccessToken('old-token');
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const refresh = refreshApiSession();
  setAccessToken('winner-token');
  finish(new Response(null, { status: 409 }));
  expect(await refresh).toBe(true);
});

it('does not expire a session when a 409 arrives before a delayed winning response', async () => {
  vi.useFakeTimers();
  setAccessToken('old-token');
  setStoredSession({ id: 'user-1', nickname: 'A', role: 'user' });
  const expired = vi.fn();
  const windowTarget = Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } });
  vi.stubGlobal('window', windowTarget);
  windowTarget.addEventListener(SESSION_EXPIRED_EVENT, expired);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    new Response(null, { status: String(input).endsWith('/auth/refresh') ? 409 : 401 })));

  const request = apiRequest('/books');
  const rejection = expect(request).rejects.toMatchObject({ status: 503, message: expect.stringContaining('重新登录') });
  await vi.advanceTimersByTimeAsync(1500);
  await rejection;
  expect(getAccessToken()).toBe('old-token');
  expect(expired).not.toHaveBeenCalled();

  // The winning response was delayed beyond the bounded wait.
  setAccessToken('winner-token');
  expect(getAccessToken()).toBe('winner-token');
});

it('treats a lost winning refresh response as uncertain, preserving local auth', async () => {
  vi.useFakeTimers();
  setAccessToken('old-token');
  setStoredSession({ id: 'user-1', nickname: 'A', role: 'user' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 409 })));
  const result = refreshApiSessionStatus();
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toBe('temporarily-unavailable');
  expect(getAccessToken()).toBe('old-token');
});

it('does not resurrect a logged-out session while a 409 is waiting', async () => {
  vi.useFakeTimers();
  setAccessToken('old-token');
  setStoredSession({ id: 'user-1', nickname: 'A', role: 'user' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 409 })));
  const result = refreshApiSessionStatus();
  await vi.advanceTimersByTimeAsync(50);
  clearAuthStorage();
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toBe('invalid');
  expect(getAccessToken()).toBeNull();
});

it('accepts a later definitive revocation when password changes during a 409 wait', async () => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  setAccessToken('old-token');
  setStoredSession({ id: 'user-1', nickname: 'A', role: 'user' });
  let refreshCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/change-password')) return new Response(null, { status: 204 });
    if (url.endsWith('/auth/refresh')) {
      refreshCount += 1;
      return new Response(null, { status: refreshCount === 1 ? 409 : 401 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const first = refreshApiSessionStatus();
  await changePassword('old-password', 'new-password');
  await vi.advanceTimersByTimeAsync(1500);
  expect(await first).toBe('temporarily-unavailable');
  // The server revoked sessions during the password change; a later 401 is conclusive.
  expect(await refreshApiSessionStatus()).toBe('invalid');
  expect(refreshCount).toBe(2);
});

it('preserves local auth after a lost refresh response for a later retry', async () => {
  setAccessToken('old-token');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection reset'); }));
  expect(await refreshApiSession()).toBe(false);
  expect(getAccessToken()).toBe('old-token');
});

it('rejects refresh cookies belonging to a different account', async () => {
  setAccessToken('token-a');
  setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    access_token: 'token-b', user: { id: 'b' },
  }), { status: 200 })));
  expect(await refreshApiSession()).toBe(false);
  expect(getAccessToken()).toBe('token-a');
});

it('discards an old account response without expiring the new login', async () => {
  setAccessToken('token-a');
  setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  const request = apiRequest('/books');
  const result = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  setAccessToken('token-b');
  setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
  finish(new Response(null, { status: 401 }));
  await result;
  expect(getAccessToken()).toBe('token-b');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
