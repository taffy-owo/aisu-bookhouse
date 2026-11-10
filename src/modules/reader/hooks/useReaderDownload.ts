import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { getAccountScope } from '../../../shared/api';
import { downloadOriginalBookFile } from '../../books';
import { createReaderDownloadController } from '../services/readerDownloadController';

export function useReaderDownload(bookId: string) {
  const scope = getAccountScope();
  const controller = useMemo(() => {
    void scope;
    return createReaderDownloadController(bookId, (book, signal) => downloadOriginalBookFile(book, signal), getAccountScope);
  }, [bookId, scope]);
  useLayoutEffect(() => () => controller.reset(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { ...state, run: controller.run };
}
