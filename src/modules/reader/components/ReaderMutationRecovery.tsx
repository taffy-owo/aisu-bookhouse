import { RefreshCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '../../../shared/components/Button';
import type { ReaderTheme } from '../types/reader';
import { ReaderReturnLink } from './ReaderReturnLink';
import { ReaderStateSurface } from './ReaderStateSurface';

export function ReaderMutationRecovery({ bookId, message, onReload, theme }: {
  bookId: string;
  message: string | null;
  onReload: () => void;
  theme: ReaderTheme;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => { sectionRef.current?.focus({ preventScroll: true }); }, []);

  return (
    <ReaderStateSurface theme={theme}>
      <section aria-labelledby="reader-mutation-title" className="reader-mutation-recovery min-w-0 outline-none" ref={sectionRef} role="alert" tabIndex={-1}>
        <h1 className="font-display text-xl font-semibold" id="reader-mutation-title">原书已更新</h1>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{message}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button className="reader-state-action" icon={<RefreshCcw className="h-4 w-4" />} onClick={onReload}>重新加载阅读器</Button>
          <ReaderReturnLink bookId={bookId} />
        </div>
      </section>
    </ReaderStateSurface>
  );
}
