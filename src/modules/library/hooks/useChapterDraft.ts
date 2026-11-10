import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getAccountScope, subscribeBeforeAccountChange } from '../../../shared/api';
import { getChapterDraft } from '../services/chapterDraft';

export function useChapterDraft(bookId: string, target: number | 'append', isOpen: boolean) {
  const scope = getAccountScope();
  const store = useMemo(() => getChapterDraft(bookId, target, scope), [bookId, target, scope]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (!isOpen) return;
    const flush = () => store.flush();
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    const unsubscribe = subscribeBeforeAccountChange(flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, [store, isOpen]);
  return { ...state, store };
}
