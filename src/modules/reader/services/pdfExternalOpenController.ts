import type { PdfUrlResolver } from './pdfDocumentController';

export interface PdfPopup { readonly closed: boolean; close: () => void; navigate: (url: string) => void }

/** Create the window during the user gesture, then renew access without reloading the reader. */
export function createPdfExternalOpenController(url: string, refreshUrl: PdfUrlResolver | undefined, openWindow: () => PdfPopup | null) {
  let state = { error: '', isOpening: false };
  let generation = 0;
  let pending: { controller: AbortController; popup: PdfPopup } | null = null;
  const listeners = new Set<() => void>();
  const publish = (error: string, isOpening: boolean) => {
    state = { error, isOpening };
    listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset: () => {
      generation += 1;
      pending?.controller.abort();
      pending?.popup.close();
      pending = null;
      publish('', false);
    },
    open: async (): Promise<void> => {
      if (state.isOpening) return;
      const request = ++generation;
      let popup: PdfPopup | null = null;
      try {
        popup = openWindow();
        if (!popup) throw new Error('浏览器阻止了新窗口，请允许弹出窗口后重试');
        const controller = new AbortController();
        pending = { controller, popup };
        publish('', true);
        const freshUrl = refreshUrl ? await refreshUrl(controller.signal) : url;
        if (request !== generation) return;
        if (!freshUrl) throw new Error('PDF 访问地址不可用');
        if (!popup.closed) popup.navigate(freshUrl);
        pending = null;
        publish('', false);
      } catch (error: unknown) {
        if (request !== generation) return;
        popup?.close();
        pending = null;
        publish(error instanceof Error ? error.message : 'PDF 打开失败', false);
      }
    },
  };
}
