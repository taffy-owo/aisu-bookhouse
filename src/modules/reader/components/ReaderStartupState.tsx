import { RefreshCcw } from 'lucide-react';
import { Button } from '../../../shared/components/Button';
import { readReaderPreferences } from '../services/readerPreferences';
import type { ReaderTheme } from '../types/reader';
import { ReaderStateSurface } from './ReaderStateSurface';
import { ReaderReturnLink } from './ReaderReturnLink';

export type ReaderStartupStatus = 'loading' | 'missing' | 'unavailable';

export function ReaderStartupState({ bookId, status, message, onRetry, dark = false, theme }: {
  bookId?: string;
  status: ReaderStartupStatus;
  message?: string;
  onRetry?: () => void;
  dark?: boolean;
  theme?: ReaderTheme;
}) {
  const readerTheme = dark ? 'dark' : theme ?? readReaderPreferences().theme;
  return (
    <ReaderStateSurface theme={readerTheme}>
      <section aria-busy={status === 'loading'} aria-labelledby="reader-startup-title" className="reader-startup-state min-w-0 w-full" role={status === 'loading' ? 'status' : 'alert'}>
        <h1 className="font-display text-xl font-semibold" id="reader-startup-title">{status === 'loading' ? '正在打开阅读器…' : status === 'missing' ? '找不到这本书' : '阅读器暂时无法连接'}</h1>
        {status !== 'loading' && <p className="mt-3 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{message ?? (status === 'missing' ? '书籍可能已被移除。' : '请检查网络后重试。')}</p>}
        <div className="mt-6 flex flex-wrap gap-3">
          {status !== 'loading' && onRetry && <Button className="reader-state-action" icon={<RefreshCcw className="h-4 w-4" />} onClick={onRetry}>重试</Button>}
          <ReaderReturnLink bookId={bookId} toCollection={status === 'missing'} />
        </div>
      </section>
    </ReaderStateSurface>
  );
}
