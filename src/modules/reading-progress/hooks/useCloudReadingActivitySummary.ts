import { useCallback, useEffect, useState } from 'react';
import { getAccountScope } from '../../../shared/api';
import { fetchCloudReadingActivitySummary, flushReadingActivityOutbox, getPendingReadingActivitySummary, type CloudReadingActivitySummary, type PendingReadingActivitySummary } from '../services/readingActivity';
import { readCloudReadingActivityCache, READING_ACTIVITY_CHANGED_EVENT } from '../services/readingActivityCache';

interface SummaryState {
  accountId?: string;
  accountScope: string;
  error: string;
  hasLoaded: boolean;
  isLoading: boolean;
  summary: CloudReadingActivitySummary | null;
  pendingActivity: PendingReadingActivitySummary;
}

/** Own the page's reads while the shared, durable outbox finishes independently. */
export function useCloudReadingActivitySummary(accountId?: string, reloadKey = 0) {
  const accountScope = getAccountScope();
  const [focusKey, setFocusKey] = useState(0);
  const [state, setState] = useState<SummaryState>(() => {
    const summary = readCloudReadingActivityCache(accountScope);
    return { accountId, accountScope, error: '', hasLoaded: Boolean(summary), isLoading: true, summary, pendingActivity: getPendingReadingActivitySummary() };
  });
  const retryActivity = useCallback(() => setFocusKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && getAccountScope() === accountScope;
    const cachedSummary = readCloudReadingActivityCache(accountScope);
    setState((current) => ({
      accountId,
      accountScope,
      error: '',
      hasLoaded: Boolean(cachedSummary) || (current.accountId === accountId && current.accountScope === accountScope && current.hasLoaded),
      isLoading: true,
      summary: cachedSummary ?? (current.accountId === accountId && current.accountScope === accountScope ? current.summary : null),
      pendingActivity: getPendingReadingActivitySummary(),
    }));

    void flushReadingActivityOutbox()
      .catch(() => {})
      .then(async () => {
        if (!isCurrent()) return;
        const summary = await fetchCloudReadingActivitySummary(controller.signal);
        if (isCurrent()) setState({ accountId, accountScope, error: '', hasLoaded: true, isLoading: false, summary, pendingActivity: getPendingReadingActivitySummary() });
      })
      .catch(() => {
        if (isCurrent()) setState((current) => ({ ...current, error: '阅读统计暂时无法读取', isLoading: false, pendingActivity: getPendingReadingActivitySummary() }));
      });

    return () => controller.abort();
  }, [accountId, accountScope, focusKey, reloadKey]);

  useEffect(() => {
    let dayTimer: ReturnType<typeof window.setTimeout> | undefined;
    const scheduleNextDay = () => {
      window.clearTimeout(dayTimer);
      if (document.visibilityState !== 'visible') return;
      const now = new Date();
      // Construct the next calendar day locally, including 23/25-hour DST days.
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      dayTimer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') setFocusKey((key) => key + 1);
        scheduleNextDay();
      }, Math.max(1, nextDay.getTime() - now.getTime() + 50));
    };
    const refresh = () => {
      if (document.visibilityState === 'visible') setFocusKey((key) => key + 1);
      scheduleNextDay();
    };
    scheduleNextDay();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(dayTimer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    const updateLocalSnapshot = () => {
      if (getAccountScope() !== accountScope) return;
      const summary = readCloudReadingActivityCache(accountScope);
      setState((current) => current.accountScope === accountScope && current.accountId === accountId
        ? { ...current, summary: summary ?? current.summary, hasLoaded: Boolean(summary) || current.hasLoaded, pendingActivity: getPendingReadingActivitySummary() }
        : current);
    };
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith('aisu-bookhouse:reading-activity') || event.key.startsWith('aisu-bookhouse:cloud-reading-activity:') || event.key.startsWith('aisu-bookhouse:book-reading-time:')) updateLocalSnapshot();
    };
    window.addEventListener(READING_ACTIVITY_CHANGED_EVENT, updateLocalSnapshot);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('online', retryActivity);
    return () => {
      window.removeEventListener(READING_ACTIVITY_CHANGED_EVENT, updateLocalSnapshot);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('online', retryActivity);
    };
  }, [accountId, accountScope, retryActivity]);

  // Mask old-account data immediately, before the next effect can run.
  const isCurrentAccount = state.accountScope === accountScope && state.accountId === accountId;
  return {
    cloudActivitySummary: isCurrentAccount ? state.summary : null,
    activityError: isCurrentAccount ? state.error : '',
    hasActivityLoaded: isCurrentAccount && state.hasLoaded,
    isActivityLoading: !isCurrentAccount || state.isLoading,
    pendingActivity: isCurrentAccount ? state.pendingActivity : { eventCount: 0, seconds: 0 },
    retryActivity,
  };
}
