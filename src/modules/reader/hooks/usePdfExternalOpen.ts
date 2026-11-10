import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PdfUrlResolver } from '../services/pdfDocumentController';
import { createPdfExternalOpenController } from '../services/pdfExternalOpenController';

export function usePdfExternalOpen(url: string, refreshUrl?: PdfUrlResolver) {
  const controller = useMemo(() => createPdfExternalOpenController(url, refreshUrl, () => {
    const popup = window.open('', '_blank');
    if (!popup) return null;
    popup.opener = null;
    return { get closed() { return popup.closed; }, close: () => popup.close(), navigate: (nextUrl: string) => popup.location.replace(nextUrl) };
  }), [refreshUrl, url]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => () => controller.reset(), [controller]);
  return { ...state, open: controller.open };
}
