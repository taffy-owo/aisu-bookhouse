import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getAccountScope } from '../../../shared/api';
import { createTranslationSubmissionQueue } from '../services/translationSubmissionQueue';
import { createWholeBookTranslation, type WholeBookTranslationJob } from '../services/wholeBookTranslationService';

export function useTranslationSubmissions(scope: string, onCreated: (job: WholeBookTranslationJob) => void) {
  const queue = useMemo(() => createTranslationSubmissionQueue({
    scope,
    getAccountScope,
    onCreated,
    create: (input, signal) => createWholeBookTranslation(input.sourceUrl, input.customInstructions, input.requestConcurrency, input.model, input.channelId, signal),
  }), [scope, onCreated]);
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  useEffect(() => {
    queue.activate();
    const reload = (event: StorageEvent) => { if (queue.matchesStorageKey(event.key)) queue.reload(); };
    window.addEventListener('storage', reload);
    return () => { window.removeEventListener('storage', reload); queue.dispose(); };
  }, [queue]);
  return { ...state, queue };
}
