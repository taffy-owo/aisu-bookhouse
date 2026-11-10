import { useCallback, useEffect, useState } from 'react';
import { apiDownload, isApiResourceUrl, getAccessToken, getAccountScope } from '../api';
import { isAbortError } from '../utils/abortError';

type AuthenticatedResourceStatus = 'idle' | 'loading' | 'success' | 'error';

type AuthenticatedResourceState = {
  accountScope?: string;
  error?: string;
  objectUrl?: string;
  sourceUrl?: string;
  status: AuthenticatedResourceStatus;
};

export type AuthenticatedResource = {
  error?: string;
  retry: () => void;
  status: AuthenticatedResourceStatus;
  url?: string;
};

export type AuthenticatedResourceOptions = {
  /**
   * Share the downloaded blob through a module-level, reference-counted cache
   * so the same URL mounted in several places (or remounted shortly after)
   * only downloads once. Enable this for small resources such as covers and
   * illustrations; large downloads (PDF originals, manga pages) should keep
   * the default per-mount behavior so they never sit in the long-lived cache.
   */
  cache?: boolean;
};

type CachedResourceEntry = {
  objectUrl?: string;
  promise?: Promise<string>;
  refCount: number;
  revokeTimerId?: ReturnType<typeof setTimeout>;
};

// Keep an unused entry alive briefly after its last consumer unmounts, so
// switching pages does not immediately drop every cover that was on screen.
const CACHE_RELEASE_REVOKE_DELAY_MS = 60_000;

const cachedResourceEntries = new Map<string, CachedResourceEntry>();

function retainCachedResource(sourceUrl: string): CachedResourceEntry {
  let entry = cachedResourceEntries.get(sourceUrl);
  if (!entry) {
    entry = { refCount: 0 };
    cachedResourceEntries.set(sourceUrl, entry);
  }

  entry.refCount += 1;
  if (entry.revokeTimerId !== undefined) {
    clearTimeout(entry.revokeTimerId);
    entry.revokeTimerId = undefined;
  }
  return entry;
}

function releaseCachedResource(cacheKey: string, entry: CachedResourceEntry): void {
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0 || entry.revokeTimerId !== undefined) {
    return;
  }

  entry.revokeTimerId = setTimeout(() => {
    if (entry.refCount > 0) {
      return;
    }
    if (cachedResourceEntries.get(cacheKey) === entry) cachedResourceEntries.delete(cacheKey);
    if (entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl);
    }
  }, CACHE_RELEASE_REVOKE_DELAY_MS);
}

function loadCachedResource(sourceUrl: string, entry: CachedResourceEntry, cacheKey: string): Promise<string> {
  if (entry.objectUrl) {
    return Promise.resolve(entry.objectUrl);
  }

  // Deduplicate concurrent mounts of the same URL onto one in-flight download.
  if (!entry.promise) {
    entry.promise = apiDownload(sourceUrl)
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        entry.promise = undefined;
        if (cachedResourceEntries.get(cacheKey) !== entry && entry.refCount === 0) {
          // Every consumer left and the entry was evicted mid-download.
          URL.revokeObjectURL(objectUrl);
          return objectUrl;
        }
        entry.objectUrl = objectUrl;
        return objectUrl;
      })
      .catch((error: unknown) => {
        entry.promise = undefined;
        // Drop the failed entry so the next mount (or retry) refetches it.
        if (cachedResourceEntries.get(cacheKey) === entry && !entry.objectUrl) {
          cachedResourceEntries.delete(cacheKey);
        }
        throw error;
      });
  }
  return entry.promise;
}

export function useAuthenticatedResource(sourceUrl: string | undefined, options: AuthenticatedResourceOptions = {}): AuthenticatedResource {
  const [retryKey, setRetryKey] = useState(0);
  const token = getAccessToken();
  const accountScope = getAccountScope();
  const shouldCache = options.cache === true;
  const [resourceState, setResourceState] = useState<AuthenticatedResourceState>({
    status: sourceUrl ? 'loading' : 'idle',
  });
  const retry = useCallback(() => {
    if (shouldCache && sourceUrl) {
      const cacheKey = JSON.stringify([accountScope, sourceUrl]);
      const entry = cachedResourceEntries.get(cacheKey);
      // Download success does not guarantee decodable image bytes. Replace
      // only the blob this consumer observed; join any newer download/cache.
      if (entry?.objectUrl && entry.objectUrl === resourceState.objectUrl) cachedResourceEntries.delete(cacheKey);
    }
    setRetryKey((currentKey) => currentKey + 1);
  }, [accountScope, resourceState.objectUrl, shouldCache, sourceUrl]);

  useEffect(() => {
    const updateState = (next: AuthenticatedResourceState) => setResourceState({ ...next, accountScope });
    if (!sourceUrl) {
      updateState({ status: 'idle' });
      return undefined;
    }

    if (!isApiResourceUrl(sourceUrl)) {
      updateState({ objectUrl: sourceUrl, sourceUrl, status: 'success' });
      return undefined;
    }

    if (shouldCache) {
      let isActive = true;
      const cacheKey = JSON.stringify([accountScope, sourceUrl]);
      const entry = retainCachedResource(cacheKey);

      if (entry.objectUrl) {
        updateState({ objectUrl: entry.objectUrl, sourceUrl, status: 'success' });
      } else {
        updateState({ sourceUrl, status: 'loading' });
        void loadCachedResource(sourceUrl, entry, cacheKey)
          .then((objectUrl) => {
            if (isActive) {
              updateState({ objectUrl, sourceUrl, status: 'success' });
            }
          })
          .catch((error: unknown) => {
            if (isAbortError(error)) {
              return;
            }
            if (isActive) {
              updateState({ error: getAuthenticatedResourceErrorMessage(error), sourceUrl, status: 'error' });
            }
          });
      }

      return () => {
        isActive = false;
        releaseCachedResource(cacheKey, entry);
      };
    }

    const controller = new AbortController();
    let isActive = true;
    let createdObjectUrl: string | undefined;

    updateState({ sourceUrl, status: 'loading' });

    void apiDownload(sourceUrl, { signal: controller.signal })
      .then((blob) => {
        createdObjectUrl = URL.createObjectURL(blob);
        if (isActive) {
          updateState({ objectUrl: createdObjectUrl, sourceUrl, status: 'success' });
        } else {
          URL.revokeObjectURL(createdObjectUrl);
        }
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
        if (isActive) {
          updateState({ error: getAuthenticatedResourceErrorMessage(error), sourceUrl, status: 'error' });
        }
      });

    return () => {
      isActive = false;
      controller.abort();
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
    };
  }, [accountScope, retryKey, shouldCache, sourceUrl, token]);

  if (!sourceUrl) {
    return { retry, status: 'idle', url: undefined };
  }

  if (!isApiResourceUrl(sourceUrl)) {
    return { retry, status: 'success', url: sourceUrl };
  }

  if (resourceState.sourceUrl !== sourceUrl || resourceState.accountScope !== accountScope) {
    return { retry, status: 'loading', url: undefined };
  }

  return {
    error: resourceState.error,
    retry,
    status: resourceState.status,
    url: resourceState.status === 'success' ? resourceState.objectUrl : undefined,
  };
}

export function useAuthenticatedResourceUrl(sourceUrl: string | undefined): string | undefined {
  return useAuthenticatedResource(sourceUrl).url;
}

function getAuthenticatedResourceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return '资源加载失败';
}
