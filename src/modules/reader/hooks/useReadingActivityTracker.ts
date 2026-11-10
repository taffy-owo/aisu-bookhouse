import { useEffect, useRef } from 'react';
import { getAccountScope, subscribeBeforeAccountChange } from '../../../shared/api';
import { queueReadingActivitySync, recordReadingActivity } from '../../reading-progress';
import { retireLocalReadingSeconds } from '../../reading-progress/services/localReadingTime';
import { createReadingActivityClock } from '../services/readingActivityClock';

const TRACKING_INTERVAL_MS = 30_000;

export function useReadingActivityTracker(isActive: boolean, bookId?: string): void {
  const scope = getAccountScope();
  const clockRef = useRef<{ identity: string; clock: ReturnType<typeof createReadingActivityClock> } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const identity = JSON.stringify([scope, bookId ?? null]);
    if (clockRef.current?.identity !== identity) {
      clockRef.current?.clock.setActive(false);
      clockRef.current = { identity, clock: createReadingActivityClock((seconds, occurredAt) => {
        recordReadingActivity(seconds, occurredAt, bookId, scope);
        // keepalive lets the pagehide/visibilitychange flush survive page teardown.
        void queueReadingActivitySync(seconds, occurredAt, bookId, { keepalive: true, accountScope: scope }).catch(() => {
          // The event is already persisted in the outbox and will replay later.
        });
      }) };
    }
    const clock = clockRef.current.clock;
    clock.setActive(isActive && document.visibilityState === 'visible' && getAccountScope() === scope);
    if (!isActive) return;
    const handleVisibilityChange = () => clock.setActive(document.visibilityState === 'visible' && getAccountScope() === scope);
    const handlePageHide = () => { clock.setActive(false); retireLocalReadingSeconds(); };
    const markInteraction = () => { if (getAccountScope() === scope) clock.interact(); else clock.setActive(false); };
    const flushActiveTime = () => { if (getAccountScope() === scope) clock.flush(); else clock.setActive(false); };
    const stopForAccountChange = () => { clock.setActive(false); retireLocalReadingSeconds(); };
    const handleStorageChange = (event: StorageEvent) => {
      if ((event.key === null || event.key === 'aisu-bookhouse:session' || event.key === 'aisu-bookhouse:access-token') && getAccountScope() !== scope) stopForAccountChange();
    };
    const unsubscribe = subscribeBeforeAccountChange(stopForAccountChange);
    const timer = window.setInterval(flushActiveTime, TRACKING_INTERVAL_MS);

    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('keydown', markInteraction, { passive: true });
    document.addEventListener('pointerdown', markInteraction, { passive: true });
    document.addEventListener('touchstart', markInteraction, { passive: true });
    document.addEventListener('wheel', markInteraction, { passive: true });
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handleVisibilityChange);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('keydown', markInteraction);
      document.removeEventListener('pointerdown', markInteraction);
      document.removeEventListener('touchstart', markInteraction);
      document.removeEventListener('wheel', markInteraction);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handleVisibilityChange);
      window.removeEventListener('storage', handleStorageChange);
      unsubscribe();
      clock.setActive(false);
      retireLocalReadingSeconds();
    };
  }, [bookId, isActive, scope]);
}
