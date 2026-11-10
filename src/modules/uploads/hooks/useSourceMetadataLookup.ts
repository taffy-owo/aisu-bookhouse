import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getAccountScope } from '../../../shared/api';
import { getWorkSourceMetadata, type WorkSourceMetadata } from '../services/sourceMetadataService';

const emptyState = { isLoading: false, error: '', metadata: null as WorkSourceMetadata | null };

/** A source request belongs to one account and one form/dialog lifecycle. */
export function useSourceMetadataLookup(ownerKey: string) {
  const scope = getAccountScope();
  const [state, setState] = useState({ ...emptyState, scope, ownerKey });
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    setState({ ...emptyState, scope, ownerKey });
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; };
  }, [scope, ownerKey]);

  const cancel = useCallback((clearResult = true) => {
    pending.current?.abort();
    pending.current = null;
    if (mounted.current) setState((current) => {
      const currentScope = getAccountScope();
      return !clearResult && current.scope === currentScope && current.ownerKey === ownerKey
        ? { ...current, isLoading: false }
        : { ...emptyState, scope: currentScope, ownerKey };
    });
  }, [ownerKey]);

  const lookup = useCallback(async (rawUrl: string, onResolved: (metadata: WorkSourceMetadata) => void) => {
    if (!mounted.current || getAccountScope() !== scope) return;
    cancel();
    const url = rawUrl.trim();
    if (!url) {
      setState({ ...emptyState, scope, ownerKey, error: '请粘贴作品链接' });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    const isCurrent = () => mounted.current && pending.current === controller && !controller.signal.aborted && getAccountScope() === scope;
    setState({ ...emptyState, scope, ownerKey, isLoading: true });
    try {
      const metadata = await getWorkSourceMetadata(url, controller.signal);
      if (!isCurrent()) return;
      onResolved(metadata);
      if (isCurrent()) setState({ ...emptyState, scope, ownerKey, metadata });
    } catch (error: unknown) {
      if (isCurrent()) setState({ ...emptyState, scope, ownerKey, error: error instanceof Error ? error.message : '作品信息读取失败' });
    } finally {
      if (isCurrent()) pending.current = null;
    }
  }, [cancel, ownerKey, scope]);

  return { ...(state.scope === scope && state.ownerKey === ownerKey ? state : emptyState), cancel, lookup };
}
