import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProfileResource<T> {
  data: T | null;
  error: string;
  isLoading: boolean;
  retry: () => void;
  replaceData: (data: T) => void;
}

/** Keep each profile section independent, and never expose another account's data. */
export function useProfileResource<T>(accountId: string | undefined, load: (signal: AbortSignal) => Promise<T>): ProfileResource<T> {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ accountId?: string; data: T | null; error: string; isLoading: boolean }>({ accountId, data: null, error: '', isLoading: Boolean(accountId) });
  const controllerRef = useRef<AbortController | null>(null);

  const retry = useCallback(() => {
    controllerRef.current?.abort();
    setRevision((current) => current + 1);
  }, []);

  const replaceData = useCallback((data: T) => {
    controllerRef.current?.abort();
    setState({ accountId, data, error: '', isLoading: false });
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ accountId, data: current.accountId === accountId ? current.data : null, error: '', isLoading: true }));
    void load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ accountId, data, error: '', isLoading: false });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, error: error instanceof Error ? error.message : '连接失败，请重试', isLoading: false }));
      });
    return () => controller.abort();
  }, [accountId, load, revision]);

  return {
    ...(state.accountId === accountId ? state : { data: null, error: '', isLoading: Boolean(accountId) }),
    retry,
    replaceData,
  };
}
