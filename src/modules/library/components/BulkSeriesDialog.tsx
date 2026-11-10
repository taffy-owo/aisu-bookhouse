import { Layers3, Unlink } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import type { Book } from '../../books';
import { createBulkSeriesDrafts, getCommonSeriesField, parseBulkSeriesOrder, type BulkSeriesDraft } from '../services/bulkSeries';

export type BulkSeriesSaveInput = {
  assignments: Array<{ book: Book; seriesOrder: number | null }>;
  seriesKind: string | null;
  seriesTitle: string | null;
};

type BulkSeriesDialogProps = {
  books: Book[];
  isOpen: boolean;
  isPending?: boolean;
  onCancel: () => void;
  onSave: (input: BulkSeriesSaveInput) => Promise<void>;
};

export function BulkSeriesDialog({ books, isOpen, isPending = false, onCancel, onSave }: BulkSeriesDialogProps) {
  const [seriesTitle, setSeriesTitle] = useState('');
  const [seriesKind, setSeriesKind] = useState('');
  const [drafts, setDrafts] = useState<BulkSeriesDraft[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const validationId = useId();
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const orderInputRefs = useRef(new Map<string, HTMLInputElement>());
  const hasPreparedDraftRef = useRef(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, onCancel, !isSaving && !isPending);
  const booksById = useMemo(() => new Map(books.map((book) => [book.id, book])), [books]);

  useEffect(() => {
    if (!isOpen) {
      hasPreparedDraftRef.current = false;
      return;
    }
    if (hasPreparedDraftRef.current) {
      // A partial save leaves only failed books selected. Keep their edits for retry.
      setDrafts((current) => {
        const byId = new Map(current.map((draft) => [draft.bookId, draft]));
        return createBulkSeriesDrafts(books).map((draft) => byId.get(draft.bookId) ?? draft);
      });
      return;
    }
    hasPreparedDraftRef.current = true;
    setSeriesTitle(getCommonSeriesField(books, 'seriesTitle'));
    setSeriesKind(getCommonSeriesField(books, 'seriesKind'));
    setDrafts(createBulkSeriesDrafts(books));
    setErrorMessage('');
    setInvalidField(null);
    setIsSaving(false);
  }, [books, isOpen]);

  if (!isOpen) return null;

  const runSave = async (remove = false) => {
    const normalizedTitle = remove ? null : seriesTitle.trim() || null;
    if (!remove && !normalizedTitle) {
      setErrorMessage('请输入系列名。');
      setInvalidField('title');
      titleInputRef.current?.focus({ preventScroll: true });
      titleInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }

    const invalidDraft = drafts.find((draft) => draft.orderText.trim() && parseBulkSeriesOrder(draft.orderText) === null);
    if (!remove && invalidDraft) {
      setErrorMessage('请输入有效数字，或留空。');
      setInvalidField(invalidDraft.bookId);
      const input = orderInputRefs.current.get(invalidDraft.bookId);
      input?.focus({ preventScroll: true });
      input?.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }

    const assignments = drafts.flatMap((draft) => {
      const book = booksById.get(draft.bookId);
      return book ? [{ book, seriesOrder: remove ? null : parseBulkSeriesOrder(draft.orderText) }] : [];
    });

    setIsSaving(true);
    setErrorMessage('');
    setInvalidField(null);
    try {
      await onSave({
        assignments,
        seriesKind: remove ? null : seriesKind.trim() || null,
        seriesTitle: normalizedTitle,
      });
      onCancel();
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : '系列设置失败，请重试。');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ViewportDialogPortal className="z-[100] grid place-items-center bg-stone-950/45 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="bulk-series-title" aria-modal="true" className="book-management-dialog book-action-dialog book-bulk-series-dialog flex max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-stone-200 bg-white shadow-2xl dark:border-white/10 dark:bg-night-surface" ref={dialogRef} role="dialog" tabIndex={-1}>
        <header className="book-bulk-series-heading border-b border-stone-200 px-5 py-5 dark:border-white/10 sm:px-6">
          <div className="flex items-start gap-3">
            <span className="book-dialog-symbol grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent dark:bg-peach/10 dark:text-peach">
              <Layers3 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="bulk-series-title">设置系列</h2>
              <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">将 {books.length} 本书收纳为同一系列。卷序已按书名预填，可逐本修改或留空。</p>
            </div>
          </div>
          <div className="book-bulk-series-fields mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <label className="grid min-w-0 gap-1.5 text-xs font-medium text-stone-600 dark:text-night-soft">
              系列名
              <input aria-describedby={invalidField === 'title' ? validationId : undefined} aria-invalid={invalidField === 'title' || undefined} ref={titleInputRef} data-dialog-autofocus className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-white px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04]" disabled={isPending || isSaving} maxLength={255} onChange={(event) => { setSeriesTitle(event.target.value); if (invalidField === 'title') { setInvalidField(null); setErrorMessage(''); } }} placeholder="例如 Overlord" value={seriesTitle} />
              {invalidField === 'title' && <span id={validationId} role="alert" className="text-sm text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{errorMessage}</span>}
            </label>
            <label className="grid min-w-0 gap-1.5 text-xs font-medium text-stone-600 dark:text-night-soft">
              系列类型（可选）
              <input className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-white px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04]" disabled={isPending || isSaving} maxLength={80} onChange={(event) => setSeriesKind(event.target.value)} placeholder="轻小说、漫画……" value={seriesKind} />
            </label>
          </div>
        </header>

        <div className="book-bulk-series-content min-h-0 flex-1 overflow-y-auto px-5 py-2 reader-scrollbar sm:px-6">
          {drafts.map((draft) => {
            const book = booksById.get(draft.bookId);
            if (!book) return null;
            return (
              <label className="book-bulk-series-row grid grid-cols-[minmax(0,1fr)_92px] items-center gap-3 border-b border-stone-100 py-3 text-sm last:border-b-0 dark:border-white/[0.06]" key={draft.bookId}>
                <span className="min-w-0">
                  <span className="block font-medium [overflow-wrap:anywhere] text-stone-900 dark:text-night-ink">{book.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-stone-400 dark:text-stone-500">{book.author || '佚名'}</span>
                </span>
                <span className="grid min-w-0 gap-1 text-[11px] text-stone-500 dark:text-stone-400">
                  卷序
                  <input aria-describedby={invalidField === draft.bookId ? validationId : undefined} aria-invalid={invalidField === draft.bookId || undefined} ref={(element) => { if (element) orderInputRefs.current.set(draft.bookId, element); else orderInputRefs.current.delete(draft.bookId); }} aria-label={`《${book.title}》卷序`} className="h-10 min-w-0 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm tabular-nums outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04]" disabled={isPending || isSaving} inputMode="decimal" onChange={(event) => { setDrafts((current) => current.map((item) => item.bookId === draft.bookId ? { ...item, orderText: event.target.value } : item)); if (invalidField === draft.bookId) { setInvalidField(null); setErrorMessage(''); } }} placeholder="留空" value={draft.orderText} />
                </span>
                {invalidField === draft.bookId && <span id={validationId} role="alert" className="col-span-full text-sm text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{errorMessage}</span>}
              </label>
            );
          })}
        </div>

        <footer className="book-bulk-series-footer border-t border-stone-200 px-5 py-4 dark:border-white/10 sm:px-6">
          {errorMessage && !invalidField && <p role="alert" className="mb-3 whitespace-pre-wrap rounded-2xl [overflow-wrap:anywhere] bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-300">{errorMessage}</p>}
          <div className="book-action-footer flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button disabled={isPending || isSaving || books.length === 0} icon={<Unlink className="h-4 w-4" />} onClick={() => void runSave(true)} variant="secondary">移出系列</Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button disabled={isPending || isSaving} onClick={onCancel} variant="secondary">取消</Button>
              <Button disabled={isPending || isSaving || books.length === 0} icon={<Layers3 className="h-4 w-4" />} onClick={() => void runSave()}>{isSaving ? '保存中…' : isPending ? '等待书架刷新…' : `保存 ${books.length} 本`}</Button>
            </div>
          </div>
        </footer>
      </div>
    </ViewportDialogPortal>
  );
}
