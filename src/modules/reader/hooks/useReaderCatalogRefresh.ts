import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { getAccountScope } from '../../../shared/api';
import type { BookPublicationStatus } from '../../books/types/book';
import { TRANSLATED_BOOKS_CHANGED_EVENT } from '../../uploads/services/wholeBookTranslationService';
import { startPolling } from '../../../shared/utils/polling';
import { getReaderResource } from '../services/readerService';
import type { ReaderResourceLoadState } from '../types/novelReaderState';
import { readerContentConflictEvent } from '../services/readerContentConflict';
import { reconcileReaderResource } from '../services/readerResourceRefresh';

export function useReaderCatalogRefresh(
  bookId: string,
  publicationStatus: BookPublicationStatus | undefined,
  isReady: boolean,
  isTocOpen: boolean,
  setResource: Dispatch<SetStateAction<ReaderResourceLoadState>>,
) {
  const accountScope = getAccountScope();
  const recoveryKey = JSON.stringify([accountScope, bookId]);
  const recoveryIntentRef = useRef({ key: recoveryKey, pending: false, revision: 0 });
  const [recovery, setRecovery] = useState({ key: recoveryKey, isChecking: false, error: null as string | null });
  if (recovery.key !== recoveryKey) setRecovery({ key: recoveryKey, isChecking: false, error: null });
  const onRetry = useCallback(() => {
    if (accountScope === getAccountScope()) window.dispatchEvent(new Event(readerContentConflictEvent(bookId, accountScope)));
  }, [accountScope, bookId]);
  useEffect(() => {
    if (!bookId || !isReady) return;
    const conflictEvent = readerContentConflictEvent(bookId, accountScope);
    if (recoveryIntentRef.current.key !== recoveryKey) recoveryIntentRef.current = { key: recoveryKey, pending: false, revision: 0 };
    const intent = recoveryIntentRef.current;
    const markConflict = () => { intent.pending = true; intent.revision += 1; };
    // Register before the polling listener so the first conflict starts a
    // visible recovery run, including when no interval polling is configured.
    window.addEventListener(conflictEvent, markConflict);
    const stop = startPolling(async (signal) => {
      if (document.visibilityState === 'hidden') return;
      if (getAccountScope() !== accountScope) return;
      const isRecovery = intent.pending;
      const revision = intent.revision;
      if (isRecovery) setRecovery({ key: recoveryKey, isChecking: true, error: null });
      try {
        const resource = await getReaderResource(bookId, signal);
        if (signal.aborted || getAccountScope() !== accountScope) return;
        setResource((current) => signal.aborted || getAccountScope() !== accountScope ? current : reconcileReaderResource(current, bookId, resource, isRecovery));
        if (isRecovery && revision === intent.revision) {
          intent.pending = false;
          setRecovery({ key: recoveryKey, isChecking: false, error: null });
        }
      } catch {
        if (isRecovery && revision === intent.revision && !signal.aborted && getAccountScope() === accountScope) {
          setRecovery({ key: recoveryKey, isChecking: false, error: '检查更新失败，请重试；当前正文和备注草稿已保留。' });
        }
      }
    }, {
      intervalMs: publicationStatus === 'ongoing' ? 60000 : null,
      immediate: isTocOpen || intent.pending,
      events: ['focus', 'visibilitychange', TRANSLATED_BOOKS_CHANGED_EVENT, conflictEvent],
    });
    return () => { stop(); window.removeEventListener(conflictEvent, markConflict); };
  }, [accountScope, bookId, publicationStatus, isReady, isTocOpen, recoveryKey, setResource]);
  return { ...(recovery.key === recoveryKey ? recovery : { isChecking: false, error: null }), onRetry };
}
