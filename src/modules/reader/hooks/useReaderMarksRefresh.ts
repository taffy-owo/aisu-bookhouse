import { useEffect } from 'react';
import { startPolling } from '../../../shared/utils/polling';
import type { createReaderMarksController } from '../services/readerMarksController';

export function useReaderMarksRefresh(controller: ReturnType<typeof createReaderMarksController>, isOpen: boolean) {
  useEffect(() => {
    if (!isOpen) return;
    return startPolling(async () => { await controller.refresh(); }, {
      // Opening while the initial list is loading already has a fresh request.
      immediate: !controller.getSnapshot().isLoading,
      events: ['focus'],
    });
  }, [controller, isOpen]);
}
