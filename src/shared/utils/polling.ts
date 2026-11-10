export interface PollingOptions {
  /** Run once as soon as the poller is created. Defaults to true. */
  immediate?: boolean;
  /** Milliseconds between visible-page runs. Omit to disable interval polling. */
  intervalMs?: number | null;
  /** Window events that should trigger a fresh run. */
  events?: readonly string[];
  /** Invalidate cached state before a visible focus or return-from-background read. */
  onResume?: () => void;
}

/**
 * Start a cancellable, single-flight polling loop for visible-page state.
 *
 * A refresh that is still in flight owns its AbortController; a later event
 * only queues one follow-up run. This prevents focus and visibility events
 * from piling up requests while preserving a final refresh after a response.
 */
export function startPolling(
  task: (signal: AbortSignal) => Promise<void> | void,
  { immediate = true, intervalMs = null, events = [], onResume }: PollingOptions = {},
): () => void {
  let disposed = false;
  let running = false;
  let queued = false;
  let timer: ReturnType<typeof window.setInterval> | undefined;
  let controller: AbortController | undefined;
  const page = typeof document === 'undefined' ? null : document;
  const isHidden = () => page?.visibilityState === 'hidden';

  const run = async () => {
    if (disposed || isHidden()) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    controller = new AbortController();
    try {
      await task(controller.signal);
    } catch {
      // Polling is best effort. The page keeps its last confirmed state and
      // the next interval or event can retry the request.
    } finally {
      controller = undefined;
      running = false;
      if (queued && !disposed) {
        queued = false;
        void run();
      }
    }
  };

  const refresh = (event?: Event) => {
    if (disposed || isHidden()) return;
    if (event?.type === 'focus') onResume?.();
    void run();
  };
  const stopInterval = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };
  const startInterval = () => {
    if (!disposed && !isHidden() && timer === undefined && intervalMs !== null && intervalMs !== undefined && intervalMs > 0) {
      timer = window.setInterval(refresh, intervalMs);
    }
  };
  const handleVisibility = () => {
    if (disposed) return;
    if (isHidden()) {
      stopInterval();
      queued = false;
    } else {
      onResume?.();
      startInterval();
      refresh();
    }
  };
  // Visibility belongs to document. Register it once even when callers also
  // list it among their refresh events; the native event bubbles to window.
  const eventNames = [...new Set(events)].filter((eventName) => eventName !== 'visibilitychange' || !page);
  eventNames.forEach((eventName) => window.addEventListener(eventName, refresh));
  page?.addEventListener('visibilitychange', handleVisibility);
  startInterval();
  if (immediate) refresh();

  return () => {
    disposed = true;
    queued = false;
    stopInterval();
    eventNames.forEach((eventName) => window.removeEventListener(eventName, refresh));
    page?.removeEventListener('visibilitychange', handleVisibility);
    controller?.abort();
  };
}
