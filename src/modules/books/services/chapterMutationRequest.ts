import { ApiError, apiRequest, assertAccountScope, getAccountScope } from '../../../shared/api';
import { createRequestId } from '../../../shared/utils/requestId';

const attempts = new Map<string, string>();
const ATTEMPT_STORAGE_PREFIX = 'aisu-bookhouse:chapter-mutation-attempt:';
const MAX_ATTEMPTS = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storedAttempt(key: string): { requestId: string; createdAt: number } | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(ATTEMPT_STORAGE_PREFIX + key) ?? 'null');
    if (value && typeof value === 'object' && 'requestId' in value && typeof value.requestId === 'string' && UUID_PATTERN.test(value.requestId)
      && 'createdAt' in value && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)) return value as { requestId: string; createdAt: number };
  } catch { /* Memory still protects retries while storage is unavailable. */ }
  return null;
}

function storeAttempt(key: string, requestId: string) {
  try {
    const storage = window.localStorage;
    const records: Array<{ key: string; createdAt: number }> = [];
    for (let i = 0; i < storage.length; i += 1) {
      const name = storage.key(i);
      if (name?.startsWith(ATTEMPT_STORAGE_PREFIX)) {
        const record = storedAttempt(name.slice(ATTEMPT_STORAGE_PREFIX.length));
        records.push({ key: name, createdAt: record?.createdAt ?? 0 });
      }
    }
    records.sort((a, b) => a.createdAt - b.createdAt);
    for (const record of records.slice(0, Math.max(0, records.length - MAX_ATTEMPTS + 1))) storage.removeItem(record.key);
    storage.setItem(ATTEMPT_STORAGE_PREFIX + key, JSON.stringify({ requestId, createdAt: Date.now() }));
  } catch { /* A quota or security error must not discard the in-memory identity. */ }
}

function withAttemptLock<T>(action: () => T): Promise<T> {
  // Different tabs can retry the same pending operation. Serialize only this
  // tiny allocation/cleanup step, never the network request itself.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.resolve(action());
  let entered = false;
  return locks.request(ATTEMPT_STORAGE_PREFIX, () => { entered = true; return action(); }).catch((error: unknown) => {
    if (entered) throw error;
    return action();
  });
}

function forgetAttempt(key: string, requestId: string) {
  if (attempts.get(key) === requestId) attempts.delete(key);
  try {
    if (storedAttempt(key)?.requestId === requestId) window.localStorage.removeItem(ATTEMPT_STORAGE_PREFIX + key);
  } catch { /* A confirmed receipt can safely be replayed if cleanup failed. */ }
}

function isConfirmedRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

/** Retain the identity after an uncertain response, including a reload or another tab. */
export async function chapterMutationRequest<T>(path: string, options: RequestInit, revision?: string): Promise<T> {
  const scope = getAccountScope();
  const payload = JSON.stringify([scope, path, options.method, options.body ?? null, revision ?? null]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  assertAccountScope(scope);
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const requestId = await withAttemptLock(() => {
    assertAccountScope(scope);
    const stored = storedAttempt(key);
    const existing = attempts.get(key) ?? stored?.requestId;
    const id = existing ?? createRequestId();
    attempts.set(key, id);
    // Persist only digests and UUIDs; a draft can contain a million characters.
    if (stored?.requestId !== id) storeAttempt(key, id);
    if (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!);
    return id;
  });
  assertAccountScope(scope);
  const headers = new Headers(options.headers);
  headers.set('Idempotency-Key', requestId);
  if (revision) headers.set('If-Match', `"${revision}"`);
  try {
    const result = await apiRequest<T>(path, { ...options, headers });
    await withAttemptLock(() => forgetAttempt(key, requestId));
    return result;
  } catch (error) {
    if (isConfirmedRejection(error)) await withAttemptLock(() => forgetAttempt(key, requestId));
    throw error;
  }
}

export function getChapterMutationErrorMessage(action: '追加' | '保存' | '删除', error: unknown): string {
  if (isConfirmedRejection(error)) return error.message;
  const hint = action === '删除' ? '可直接重试核对原操作。' : '正文已保留，可用相同内容重试核对。';
  return `${action}结果未确认，${hint}${error instanceof Error ? error.message : ''}`;
}
