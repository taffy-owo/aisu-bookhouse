import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { getAccountScope } from '../../../shared/api';
import { compareAppTimestamps } from '../../../shared/utils/formatDate';
import { getReaderChapter, getReaderResource, resetReaderChapterCache } from '../services/readerService';
import { reconcileReaderResource } from '../services/readerResourceRefresh';
import type { ReaderChapter, ReaderResource } from '../types/reader';
import type { ReaderResourceLoadState } from '../types/novelReaderState';

/** An explicit update keeps the old text readable until a consistent new copy arrives. */
export function useReaderChapterRefresh(bookId: string, chapter: ReaderChapter | null, resource: ReaderResource | null, isOutdated: boolean, hasPendingEdition: boolean,
  setResource: Dispatch<SetStateAction<ReaderResourceLoadState>>, onApply: (chapter: ReaderChapter) => void) {
  const scope = getAccountScope();
  const key = JSON.stringify([scope, bookId, chapter?.index, chapter?.positionKey, chapter?.contentVersion]);
  const [state, setState] = useState({ key, isLoading: false, error: null as string | null });
  const requestRef = useRef<AbortController | null>(null);
  const latest = useRef({ key, resource, hasPendingEdition, onApply });
  useLayoutEffect(() => { latest.current = { key, resource, hasPendingEdition, onApply }; }, [key, resource, hasPendingEdition, onApply]);
  if (state.key !== key) setState({ key, isLoading: false, error: null });
  const cancel = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setState(current => current.isLoading ? { ...current, isLoading: false } : current);
  }, []);
  useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, [key, hasPendingEdition]);
  const onLoad = useCallback(() => {
    if (!chapter || !isOutdated || hasPendingEdition || requestRef.current || scope !== getAccountScope()) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ key, isLoading: true, error: null });
    const isCurrent = () => !controller.signal.aborted && latest.current.key === key && !latest.current.hasPendingEdition && scope === getAccountScope();
    void (async () => {
      const resource = await getReaderResource(bookId, controller.signal);
      if (!isCurrent()) return;
      setResource(current => isCurrent() ? reconcileReaderResource(current, bookId, resource, true) : current);
      if (resource.readerType !== 'epub' && resource.readerType !== 'text') throw new Error('阅读文件已更新，请打开新版阅读器。');
      const target = (chapter.positionKey ? resource.toc.find(item => item.positionKey === chapter.positionKey) : undefined)
        ?? resource.toc.find(item => item.index === Math.min(chapter.index, resource.chapterCount));
      if (!target) throw new Error('本话已被删除，当前正文和草稿仍保留，请从目录选择章节。');
      resetReaderChapterCache(bookId);
      const next = await getReaderChapter(bookId, target.index, controller.signal);
      const confirmed = await getReaderResource(bookId, controller.signal);
      if (!isCurrent()) return;
      if (compareAppTimestamps(latest.current.resource?.version ?? '', confirmed.version ?? '') > 0) throw new Error('本话仍在更新，请重试；当前正文和草稿已保留。');
      setResource(current => isCurrent() ? reconcileReaderResource(current, bookId, confirmed, true) : current);
      const current = 'toc' in confirmed ? confirmed.toc.find(item => item.index === target.index) : undefined;
      if (!current || next.index !== target.index || confirmed.readerType !== resource.readerType || current.positionKey !== next.positionKey
        || (current.contentVersion && current.contentVersion !== next.contentVersion)) {
        throw new Error('本话仍在更新，请重试；当前正文和草稿已保留。');
      }
      latest.current.onApply(next);
    })().catch((error: unknown) => {
      if (isCurrent()) setState({ key, isLoading: false, error: error instanceof Error ? error.message : '新版加载失败，当前正文和草稿已保留。' });
    }).finally(() => {
      if (requestRef.current === controller) { requestRef.current = null; if (isCurrent()) setState(current => ({ ...current, isLoading: false })); }
    });
  }, [bookId, chapter, hasPendingEdition, isOutdated, key, scope, setResource]);
  return { ...(state.key === key ? state : { isLoading: false, error: null }), onLoad, cancel };
}
