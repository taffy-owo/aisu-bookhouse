import { useCallback, useEffect, useState } from 'react';
import { useAuthenticatedResource, type AuthenticatedResource, type AuthenticatedResourceOptions } from './useAuthenticatedResourceUrl';

export function useAuthenticatedImageResource(sourceUrl: string | undefined, options: AuthenticatedResourceOptions = { cache: true }): AuthenticatedResource & { onError: () => void } {
  const resource = useAuthenticatedResource(sourceUrl, options);
  const { retry: retryResource, url: resourceUrl } = resource;
  const [failedUrl, setFailedUrl] = useState<string>();
  const failedDecode = Boolean(resource.url && failedUrl === resource.url);
  const hasError = resource.status === 'error' || failedDecode;
  const retry = useCallback(() => {
    setFailedUrl(undefined);
    retryResource();
  }, [retryResource]);
  const onError = useCallback(() => {
    if (resourceUrl) setFailedUrl(resourceUrl);
  }, [resourceUrl]);

  useEffect(() => {
    if (!hasError) return;
    let frame: number | undefined;
    const recover = () => {
      if (document.visibilityState === 'hidden' || frame !== undefined) return;
      // Returning to a page can emit visibility, focus and online together.
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (document.visibilityState !== 'hidden') retry();
      });
    };
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [hasError, retry]);

  return { ...resource, onError, retry, status: hasError ? 'error' : resource.status,
    error: failedDecode ? '图片无法显示' : resource.error, url: hasError ? undefined : resource.url };
}

export function useAuthenticatedImageUrl(sourceUrl: string | undefined): string | undefined {
  // Image usage (covers, illustrations) shares the module-level blob cache;
  // large downloads such as PDF originals keep the uncached default.
  return useAuthenticatedImageResource(sourceUrl).url;
}
