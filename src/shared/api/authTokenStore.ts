const ACCESS_TOKEN_STORAGE_KEY = 'aisu-bookhouse:access-token';
const SESSION_STORAGE_KEY = 'aisu-bookhouse:session';
let memoryAccessToken: string | null = null;
let memorySession: StoredSession | null = null;
let tokenMemoryOnly = false;
let sessionMemoryOnly = false;
const beforeAccountChange = new Set<() => void>();
let notifyingAccountChange = false;

/** Persist account-owned work synchronously before credentials disappear. */
export function subscribeBeforeAccountChange(listener: () => void): () => void {
  beforeAccountChange.add(listener);
  return () => { beforeAccountChange.delete(listener); };
}

function notifyBeforeAccountChange() {
  if (notifyingAccountChange) return;
  notifyingAccountChange = true;
  try {
    for (const listener of beforeAccountChange) {
      try { listener(); } catch { /* A failed cleanup cannot block logout. */ }
    }
  } finally { notifyingAccountChange = false; }
}

export type StoredSession = {
  avatar?: string | null;
  email?: string;
  id: string;
  nickname: string;
  role: 'admin' | 'user';
  status?: string;
};

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getAccessToken(): string | null {
  try {
    const storage = getStorage();
    return storage && !tokenMemoryOnly ? storage.getItem(ACCESS_TOKEN_STORAGE_KEY) : memoryAccessToken;
  } catch {
    return memoryAccessToken;
  }
}

export function setAccessToken(token: string): void {
  memoryAccessToken = token;

  try {
    const storage = getStorage();
    tokenMemoryOnly = !storage;
    storage?.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  } catch {
    tokenMemoryOnly = true;
    // Private or hardened browser modes can reject storage writes.
  }
}

export function clearAccessToken(): void {
  memoryAccessToken = null;

  try {
    const storage = getStorage();
    tokenMemoryOnly = !storage;
    storage?.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    tokenMemoryOnly = true;
    // Storage may be unavailable; in-memory state has already been cleared.
  }
}

export function getStoredSession(): StoredSession | null {
  try {
    const storage = getStorage();
    if (!storage || sessionMemoryOnly) return memorySession;
    const rawSession = storage.getItem(SESSION_STORAGE_KEY);

    if (!rawSession) {
      return null;
    }

    const parsed: unknown = JSON.parse(rawSession);
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || typeof parsed.id !== 'string' || !parsed.id
      || !('nickname' in parsed) || typeof parsed.nickname !== 'string'
      || !('role' in parsed) || !['admin', 'user'].includes(String(parsed.role))) return null;
    return parsed as StoredSession;
  } catch {
    clearStoredSession();
    return null;
  }
}

export function setStoredSession(session: StoredSession): void {
  if (getStoredSession()?.id !== session.id) notifyBeforeAccountChange();
  memorySession = session;

  try {
    const storage = getStorage();
    sessionMemoryOnly = !storage;
    storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    sessionMemoryOnly = true;
    // Keep the current tab usable even when persistent storage is blocked.
  }
}

export function clearStoredSession(): void {
  notifyBeforeAccountChange();
  memorySession = null;

  try {
    const storage = getStorage();
    sessionMemoryOnly = !storage;
    storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    sessionMemoryOnly = true;
    // Storage may be unavailable; in-memory state has already been cleared.
  }
}

export function clearAuthStorage(): void {
  clearStoredSession();
  clearAccessToken();
}

/** Stable across token refresh, different after logout or account switching. */
export function getAccountScope(): string {
  return JSON.stringify(getStoredSession()?.id ?? null);
}
