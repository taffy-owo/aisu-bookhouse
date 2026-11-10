import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getAccountScope } from '../../../shared/api';
import type { WorkSourceMetadata } from '../services/sourceMetadataService';
import { createTranslationLookupState, shouldRequestTranslationLookup } from '../services/translationLookupState';
import { useSourceMetadataLookup } from './useSourceMetadataLookup';

export function useTranslationSourceLookup(isActive: boolean) {
  const scope = getAccountScope();
  const [draft, setDraft] = useState({ scope, url: '', preview: null as WorkSourceMetadata | null });
  const lookupState = useRef(createTranslationLookupState());
  const timer = useRef<number | null>(null);
  const { cancel, lookup, isLoading, error } = useSourceMetadataLookup(`translation:${isActive}`);
  const visible = draft.scope === scope ? draft : { scope, url: '', preview: null };

  const cancelScheduledLookup = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useLayoutEffect(() => {
    cancelScheduledLookup();
    lookupState.current.requested = '';
    setDraft({ scope, url: '', preview: null });
  }, [scope, cancelScheduledLookup]);

  const editUrl = useCallback((url: string) => {
    if (getAccountScope() !== scope) return;
    // Stop both the queued debounce and the dispatched request before writing
    // the new input, rather than waiting for its next lookup to begin.
    cancelScheduledLookup();
    cancel();
    lookupState.current.requested = '';
    setDraft({ scope, url, preview: null });
  }, [cancel, cancelScheduledLookup, scope]);

  useLayoutEffect(() => {
    if (!isActive) {
      lookupState.current.requested = visible.preview?.source_url ?? '';
      return;
    }
    if (!shouldRequestTranslationLookup(visible.url, lookupState.current, 'translation')) return;
    const url = visible.url.trim();
    const timerId = window.setTimeout(() => {
      if (timer.current !== timerId || getAccountScope() !== scope) return;
      timer.current = null;
      lookupState.current.requested = url;
      void lookup(url, (metadata) => {
        lookupState.current.requested = metadata.source_url;
        setDraft((current) => current.scope === scope && current.url.trim() === url
          ? { scope, url: metadata.source_url, preview: metadata }
          : current);
      });
    }, 650);
    timer.current = timerId;
    return () => {
      window.clearTimeout(timerId);
      if (timer.current === timerId) timer.current = null;
    };
  }, [isActive, lookup, scope, visible.url, visible.preview]);

  return { url: visible.url, preview: visible.preview, editUrl, clear: () => editUrl(''), isLoading, error };
}
