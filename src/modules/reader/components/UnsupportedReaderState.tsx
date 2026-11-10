import { Button } from '../../../shared/components/Button';
import { readReaderPreferences } from '../services/readerPreferences';
import type { ReaderTheme } from '../types/reader';
import { ReaderStateSurface } from './ReaderStateSurface';
import { ReaderReturnLink } from './ReaderReturnLink';
import type { Book } from '../../books';

interface UnsupportedReaderStateProps {
  book: Book;
  downloadError?: string | null;
  isDownloadDisabled?: boolean;
  isDownloadPreparing?: boolean;
  message: string;
  onDownload: () => void;
  theme?: ReaderTheme;
}

export function UnsupportedReaderState({
  book,
  downloadError,
  isDownloadDisabled = false,
  isDownloadPreparing = false,
  message,
  onDownload,
  theme,
}: UnsupportedReaderStateProps) {
  return (
    <ReaderStateSurface theme={theme ?? readReaderPreferences().theme}>
      <section aria-labelledby="reader-unsupported-title" className="reader-unsupported-state min-w-0 w-full">
        <h1 className="font-display text-xl font-semibold" id="reader-unsupported-title">暂不支持在线阅读</h1>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{message}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button aria-busy={isDownloadPreparing} className="reader-state-action" disabled={isDownloadDisabled || isDownloadPreparing} onClick={onDownload}>
            {isDownloadPreparing ? '正在准备下载…' : '下载原文件'}
          </Button>
          <ReaderReturnLink bookId={book.id} />
        </div>
        {downloadError && <p role="alert" className="mt-4 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{downloadError}</p>}
      </section>
    </ReaderStateSurface>
  );
}
