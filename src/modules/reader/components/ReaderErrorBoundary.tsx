import { useEffect, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { ErrorBoundary, type ErrorBoundaryFallbackProps } from '../../../shared/components/ErrorBoundary';
import { Button } from '../../../shared/components/Button';
import { isAssetLoadError } from '../../../shared/utils/assetLoadRecovery';
import { createLocationResetKey } from '../../../app/locationResetKey';
import { applyReaderBrowserChromeTheme } from '../services/readerBrowserChrome';
import { readReaderPreferences } from '../services/readerPreferences';
import { ReaderStateSurface } from './ReaderStateSurface';
import { ReaderReturnLink } from './ReaderReturnLink';

function ReaderErrorState({ error, isOffline, onRetry, onReload }: ErrorBoundaryFallbackProps) {
  const { bookId } = useParams();
  const { pathname } = useLocation();
  // Read after the failure: the reader may have changed its theme since its
  // route boundary mounted, without rerendering that parent.
  const theme = pathname.startsWith('/reader/manga/') ? 'dark' : readReaderPreferences().theme;
  useEffect(() => applyReaderBrowserChromeTheme(theme), [theme]);
  const assetLoadFailed = isAssetLoadError(error);
  return (
    <ReaderStateSurface theme={theme}>
      <section aria-labelledby="reader-error-title" className="reader-render-error min-w-0 w-full" role="alert">
        <h1 className="font-display text-xl font-semibold" id="reader-error-title">{assetLoadFailed ? '阅读器资源未能加载' : '阅读器暂时遇到问题'}</h1>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{assetLoadFailed
          ? isOffline ? '网络连接已断开。连接恢复后，可以重新加载阅读器。' : '阅读器资源没有加载成功，可以重新加载，或先返回图书详情。'
          : '可以重试打开当前章节；如果仍然失败，请刷新页面。已保存的阅读位置会保留。'}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button className="reader-state-action" disabled={assetLoadFailed && isOffline} onClick={onRetry}>{assetLoadFailed ? '重新加载' : '重试'}</Button>
          {!assetLoadFailed && <Button className="reader-state-action" onClick={onReload} variant="secondary">刷新页面</Button>}
          <ReaderReturnLink bookId={bookId} />
        </div>
      </section>
    </ReaderStateSurface>
  );
}

export function ReaderErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary renderFallback={(props) => <ReaderErrorState {...props} />} resetKey={createLocationResetKey(location)}>{children}</ErrorBoundary>;
}
