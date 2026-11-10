/** Optional resolver used when a PDF access ticket must be renewed before opening. */
export type PdfUrlResolver = (signal: AbortSignal) => Promise<string>;

type LoadingTask<Document> = { promise: Promise<Document>; destroy: () => unknown };
export type PdfDocumentController = {
  load: (url: string) => Promise<boolean>;
  isLoading: () => boolean;
  releaseRetired: () => void;
  dispose: () => void;
};

/** A candidate owns its worker until it is prepared; failures never retire the visible document. */
export function createPdfDocumentController<Document, Prepared>(options: {
  load: (url: string) => LoadingTask<Document>;
  prepare: (document: Document, signal: AbortSignal) => Promise<Prepared>;
  onReady: (prepared: Prepared) => void;
  onError: (error: unknown, hasDocument: boolean) => void;
  onLoading: (loading: boolean) => void;
}): PdfDocumentController {
  type Request = { url: string; task: LoadingTask<Document>; result: Promise<boolean>; controller: AbortController };
  let candidate: Request | null = null;
  let active: Request | null = null;
  let disposed = false;
  const retired = new Set<Request>();
  const destroyed = new WeakSet<LoadingTask<Document>>();
  const destroy = (request: Request | null) => {
    if (!request || destroyed.has(request.task)) return;
    destroyed.add(request.task);
    request.controller.abort();
    try { void Promise.resolve(request.task.destroy()).catch(() => {}); } catch { /* Cleanup cannot replace the original load result. */ }
  };
  return {
    load(url) {
      if (disposed) return Promise.resolve(false);
      if (candidate?.url === url) return candidate.result;
      destroy(candidate);
      candidate = null;
      options.onLoading(true);
      let task: LoadingTask<Document>;
      try { task = options.load(url); }
      catch (error) { options.onLoading(false); options.onError(error, Boolean(active)); return Promise.resolve(false); }
      const request: Request = { url, task, result: Promise.resolve(false), controller: new AbortController() };
      candidate = request;
      request.result = (async () => {
        try {
          const document = await task.promise;
          if (disposed || candidate !== request) return false;
          const prepared = await options.prepare(document, request.controller.signal);
          if (disposed || candidate !== request) return false;
          options.onReady(prepared);
          if (disposed || candidate !== request) return false;
          if (active) retired.add(active);
          active = request;
          candidate = null;
          options.onLoading(false);
          return true;
        } catch (error) {
          if (!disposed && candidate === request) {
            candidate = null;
            destroy(request);
            options.onLoading(false);
            options.onError(error, Boolean(active));
          }
          return false;
        }
      })();
      return request.result;
    },
    releaseRetired() {
      for (const request of retired) destroy(request);
      retired.clear();
    },
    isLoading: () => Boolean(candidate),
    dispose() {
      if (disposed) return;
      disposed = true;
      destroy(candidate); destroy(active);
      for (const request of retired) destroy(request);
      candidate = null; active = null; retired.clear();
    },
  };
}
