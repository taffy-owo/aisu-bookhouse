import { buildApiUrl, isApiResourceUrl } from './apiConfig';
import { clearAuthStorage, getAccessToken, getAccountScope, getStoredSession, setAccessToken } from './authTokenStore';
import { validationErrorMessage } from './validationErrorMessage';
import { isAbortError } from '../utils/abortError';
import { observeApiServerTime } from './serverClock';

export class ApiError extends Error {
  readonly payload: unknown;
  readonly status: number;

  constructor(message: string, status: number, payload: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.payload = payload;
    this.status = status;
  }
}

/**
 * Fired on window whenever the API answers 401, so the app shell can drop the
 * in-memory session (route guards then redirect to login) instead of leaving
 * the UI in a zombie state where every write silently fails.
 */
export const SESSION_EXPIRED_EVENT = 'aisu:session-expired';
const TRANSIENT_RETRY_DELAYS_MS = [250, 750] as const;
const TRANSIENT_RESPONSE_STATUSES = new Set([502, 503, 504]);
export type SessionRefreshStatus = 'refreshed' | 'invalid' | 'temporarily-unavailable';
let refreshSessionPromise: Promise<SessionRefreshStatus> | null = null;
let refreshTokenAtRequest: string | null = null;

export function assertAccountScope(expected: string): void {
  if (getAccountScope() !== expected) throw new DOMException('账号已切换，已取消旧请求', 'AbortError');
}

export function expireApiSession(): void {
  clearAuthStorage();

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
}

export async function apiRequest<TResponse>(path: string, options: RequestInit = {}): Promise<TResponse> {
  const scope = getAccountScope();
  const requestedAt = performance.now();
  const url = buildApiUrl(path);
  const response = await fetchWithSessionRecovery(url, options);
  assertAccountScope(scope);
  observeApiServerTime(response.headers, requestedAt);

  if (!response.ok) {
    const error = await createApiError(response);
    assertAccountScope(scope);
    throw error;
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const payload = await response.json() as TResponse;
  assertAccountScope(scope);
  return payload;
}

export async function apiDownload(path: string, options: Pick<RequestInit, 'signal'> = {}): Promise<Blob> {
  const scope = getAccountScope();
  const url = buildApiUrl(path);
  const response = await fetchWithSessionRecovery(url, { signal: options.signal });
  assertAccountScope(scope);

  if (!response.ok) {
    const error = await createApiError(response);
    assertAccountScope(scope);
    throw error;
  }

  const blob = await response.blob();
  assertAccountScope(scope);
  return blob;
}

async function fetchWithSessionRecovery(url: string, options: RequestInit): Promise<Response> {
  const scope = getAccountScope();
  const tokenAtRequest = getAccessToken();
  const response = await fetchWithTransientRetry(url, options);
  assertAccountScope(scope);
  if (response.status !== 401 || !tokenAtRequest || !isApiResourceUrl(url) || isRefreshExcluded(url)) {
    return response;
  }

  const refreshStatus = getAccessToken() !== tokenAtRequest && Boolean(getAccessToken())
    ? 'refreshed' : await refreshApiSessionStatus();
  assertAccountScope(scope);
  if (refreshStatus !== 'refreshed') {
    // A newer login/token refresh must not be expired by an older failure.
    if (getAccessToken() && getAccessToken() !== tokenAtRequest) return fetchWithTransientRetry(url, options);
    if (refreshStatus === 'temporarily-unavailable') {
      throw new ApiError('登录状态暂时无法确认。若重试仍失败，请先复制未保存的编辑内容，再退出并重新登录；未同步阅读进度会保留在本机。', 503);
    }
    const error = await createApiError(response);
    assertAccountScope(scope);
    expireApiSession();
    throw error;
  }

  return fetchWithTransientRetry(url, options);
}

async function fetchWithTransientRetry(url: string, options: RequestInit): Promise<Response> {
  const scope = getAccountScope();
  const canRetry = isIdempotentApiRead(url, options);
  let lastError: unknown;

  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      assertAccountScope(scope);
      const response = await fetch(url, buildRequestOptions(url, options));
      const shouldRetryResponse = canRetry
        && TRANSIENT_RESPONSE_STATUSES.has(response.status)
        && attempt < TRANSIENT_RETRY_DELAYS_MS.length;
      if (!shouldRetryResponse) {
        return response;
      }
      // This response is discarded. Cancel its body before retrying so the
      // unused download does not keep consuming a connection.
      void response.body?.cancel().catch(() => undefined);
    } catch (error: unknown) {
      if (!canRetry || isAbortError(error) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
        throw error;
      }
      lastError = error;
    }

    await waitForRetry(TRANSIENT_RETRY_DELAYS_MS[attempt], options.signal);
  }

  throw lastError instanceof Error ? lastError : new TypeError('网络请求失败');
}

function isIdempotentApiRead(url: string, options: RequestInit): boolean {
  const method = (options.method ?? 'GET').toUpperCase();
  return isApiResourceUrl(url) && (method === 'GET' || method === 'HEAD' || method === 'OPTIONS');
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timerId);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timerId = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function buildRequestOptions(url: string, options: RequestInit): RequestInit {
  return {
    ...options,
    credentials: 'include',
    headers: buildHeaders(url, options.headers, options.body),
  };
}

export function refreshApiSession(): Promise<boolean> {
  return refreshApiSessionStatus().then((result) => result === 'refreshed');
}

export function refreshApiSessionStatus(): Promise<SessionRefreshStatus> {
  const token = getAccessToken();
  if (refreshSessionPromise && refreshTokenAtRequest === token) {
    return refreshSessionPromise;
  }

  const request = performCoordinatedSessionRefresh(token).finally(() => {
    if (refreshSessionPromise === request) refreshSessionPromise = null;
  });
  refreshTokenAtRequest = token;
  refreshSessionPromise = request;
  return request;
}

async function performCoordinatedSessionRefresh(tokenAtRequest: string | null): Promise<SessionRefreshStatus> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('aisu:session-refresh', { mode: 'exclusive' }, async () => {
      if (getAccessToken() !== tokenAtRequest) return getAccessToken() ? 'refreshed' : 'invalid';
      return performSessionRefresh(tokenAtRequest);
    });
  }
  return performSessionRefresh(tokenAtRequest);
}

async function performSessionRefresh(tokenAtRequest: string | null): Promise<SessionRefreshStatus> {
  const userId = getStoredSession()?.id;
  try {
    const response = await fetch(buildApiUrl('/auth/refresh'), {
      credentials: 'include',
      method: 'POST',
    });
    if (response.status === 409) {
      return waitForPeerRefresh(tokenAtRequest);
    }
    if (!response.ok) {
      return [400, 401, 403].includes(response.status) ? 'invalid' : 'temporarily-unavailable';
    }
    const payload = await response.json() as { access_token?: unknown; user?: { id?: unknown } };
    if (getAccessToken() !== tokenAtRequest) return 'temporarily-unavailable';
    if (userId && payload.user?.id !== userId) return 'invalid';
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      return 'temporarily-unavailable';
    }
    setAccessToken(payload.access_token);
    return 'refreshed';
  } catch {
    return 'temporarily-unavailable';
  }
}

async function waitForPeerRefresh(tokenAtRequest: string | null): Promise<SessionRefreshStatus> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = getAccessToken();
    if (current !== tokenAtRequest) return current ? 'refreshed' : 'invalid';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // A 409 only proves that another request won the cookie rotation. Its
  // response may still be in flight (or lost), so elapsed time cannot prove
  // this session was revoked. Keep local state and surface a retryable error.
  return 'temporarily-unavailable';
}

function isRefreshExcluded(url: string): boolean {
  const base = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const pathname = new URL(url, base).pathname.replace(/\/$/, '');
  return ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'].some((suffix) => pathname.endsWith(suffix));
}

function buildHeaders(url: string, inputHeaders: HeadersInit | undefined, body: BodyInit | null | undefined): Headers {
  const headers = new Headers(inputHeaders);
  const token = getAccessToken();

  // Only attach the bearer token to our own API so it is never leaked to an
  // external origin (e.g. an absolute URL handed to apiDownload).
  if (token && isApiResourceUrl(url)) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (body !== undefined && body !== null && !(body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return headers;
}

async function createApiError(response: Response): Promise<ApiError> {
  const payload = await readErrorPayload(response);
  return new ApiError(getErrorMessage(payload, response.statusText), response.status, payload);
}

async function readErrorPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? '';

  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }

  return response.text();
}

export function getApiErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null && 'detail' in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    if (Array.isArray(detail)) return validationErrorMessage(detail);
    if (typeof detail === 'object' && detail !== null && 'error_code' in detail) {
      return getApiErrorCodeMessage((detail as { error_code?: unknown }).error_code, fallback);
    }
  }

  return fallback || '请求失败';
}

function getErrorMessage(payload: unknown, fallback: string): string {
  return getApiErrorMessage(payload, fallback);
}

function getApiErrorCodeMessage(errorCode: unknown, fallback: string): string {
  if (typeof errorCode !== 'string') {
    return fallback || '请求失败';
  }

  const messageMap: Record<string, string> = {
    file_too_large: '文件超过上传限制，请压缩后再上传。',
    processing_failed: '文件处理失败，请检查文件内容后重试。',
    unsupported_format: '暂不支持该文件格式。',
  };

  return messageMap[errorCode] ?? (fallback || '请求失败');
}
