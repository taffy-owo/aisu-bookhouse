import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getMangaReaderPath, getNovelReaderPath } from '../../../config/routes';
import { getAccountScope } from '../../../shared/api';
import { compareAppTimestamps, parseAppDate } from '../../../shared/utils/formatDate';
import { getReaderStartup } from '../services/readerService';
import { stageReaderStartup } from '../services/readerStartupHandoff';
import { readerPageIdentity } from '../services/readerResourceRefresh';
import type { ReaderResource } from '../types/reader';
import { getBrowserReaderAvailability } from '../../books';

export type ReaderEditionSwitch = { isLoading: boolean; error: string | null; onLoad: () => void };

export function useReaderEditionSwitch(bookId: string, pendingResource: ReaderResource | undefined, onReload: () => void): ReaderEditionSwitch | undefined {
  const navigate = useNavigate();
  const location = useLocation();
  const scope = getAccountScope();
  const key = JSON.stringify([scope, bookId]);
  const [state, setState] = useState({ key, isLoading: false, error: null as string | null });
  const requestRef = useRef<AbortController | null>(null);
  const latestPendingRef = useRef(pendingResource);
  useLayoutEffect(() => { latestPendingRef.current = pendingResource; }, [pendingResource]);
  if (state.key !== key) setState({ key, isLoading: false, error: null });
  useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, [key]);
  const onLoad = useCallback(() => {
    if (!pendingResource || requestRef.current || scope !== getAccountScope()) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ key, isLoading: true, error: null });
    void getReaderStartup(bookId, undefined, controller.signal).then((startup) => {
      if (controller.signal.aborted || scope !== getAccountScope()) return;
      const latestPending = latestPendingRef.current;
      const expectedTime = parseAppDate(latestPending?.version ?? '').getTime();
      const versionOrder = compareAppTimestamps(startup.resource.version ?? '', latestPending?.version ?? '');
      const expectedIdentity = readerPageIdentity(latestPending);
      const loadedIdentity = readerPageIdentity(startup.resource);
      const isProvablyNewer = versionOrder > 0;
      if (!latestPending || startup.book.readerType !== startup.resource.readerType || (Number.isFinite(expectedTime) && (!Number.isFinite(versionOrder) || versionOrder < 0)) || (expectedIdentity && expectedIdentity !== loadedIdentity && !isProvablyNewer)) throw new Error('新版文件仍在更新，请稍后重试。');
      const availability = getBrowserReaderAvailability(startup.book, startup.resource);
      if (!availability.canReadInBrowser) throw new Error(availability.reason ?? '新版正文尚未准备好，请稍后重试；当前内容和草稿已保留。');
      stageReaderStartup(bookId, startup);
      const path = startup.resource.readerType === 'comic' || startup.resource.readerType === 'image' ? getMangaReaderPath(bookId) : getNovelReaderPath(bookId);
      navigate(path, { replace: true, state: location.state });
      if (path === location.pathname) onReload();
      setState({ key, isLoading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && scope === getAccountScope()) setState({ key, isLoading: false, error: error instanceof Error ? error.message : '新版打开失败，当前内容和备注草稿已保留。' });
    }).finally(() => { if (requestRef.current === controller) requestRef.current = null; });
  }, [bookId, key, location.pathname, location.state, navigate, onReload, pendingResource, scope]);
  return pendingResource ? { ...(state.key === key ? state : { isLoading: false, error: null }), onLoad } : undefined;
}
