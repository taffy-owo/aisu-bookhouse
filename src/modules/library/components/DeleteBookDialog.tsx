import { AlertTriangle, Trash2, X } from 'lucide-react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';

interface DeleteBookDialogProps {
  bookTitle: string;
  errorMessage?: string;
  isDeleting: boolean;
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteBookDialog({ bookTitle, errorMessage, isDeleting, isOpen, onCancel, onConfirm }: DeleteBookDialogProps) {
  const dialogRef = useDialogFocus<HTMLElement>(isOpen, onCancel, !isDeleting);
  if (!isOpen) {
    return null;
  }

  return (
    <ViewportDialogPortal className="z-[100] grid place-items-center bg-stone-950/55 backdrop-blur-sm" onClick={isDeleting ? undefined : onCancel}>
      <section
        aria-labelledby="delete-book-title"
        aria-modal="true"
        className="book-management-dialog book-action-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-[460px] overflow-y-auto rounded-[28px] border border-white/70 bg-white p-5 shadow-[0_26px_90px_rgba(28,22,22,0.28)] reader-scrollbar dark:border-white/10 dark:bg-night"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="book-dialog-symbol grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/30 dark:text-red-300">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <button
            aria-label="关闭删除确认"
            className="book-dialog-close grid h-9 w-9 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-night-ink"
            disabled={isDeleting}
            onClick={onCancel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <h2 className="mt-5 font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="delete-book-title">
          删除这本书？
        </h2>
        <p className="mt-3 text-sm leading-7 [overflow-wrap:anywhere] text-stone-500 dark:text-night-soft">
          《{bookTitle}》会从书架移除，并删除服务器上的原文件、封面和解析缓存；累计阅读时长会永久保留在账号统计中。图书文件删除后不可恢复。
        </p>
        {errorMessage && <p role="alert" className="mt-4 whitespace-pre-wrap rounded-2xl bg-red-50 [overflow-wrap:anywhere] px-4 py-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-300">{errorMessage}</p>}
        <div className="book-action-footer mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button className="sm:min-w-24" disabled={isDeleting} onClick={onCancel} variant="secondary">
            取消
          </Button>
          <Button className="sm:min-w-32" disabled={isDeleting} icon={<Trash2 className="h-4 w-4" />} onClick={onConfirm} variant="danger">
            {isDeleting ? '删除中...' : '确认删除'}
          </Button>
        </div>
      </section>
    </ViewportDialogPortal>
  );
}
