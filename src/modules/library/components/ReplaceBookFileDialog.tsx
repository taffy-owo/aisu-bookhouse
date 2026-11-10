import { Check, FileUp, LoaderCircle, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { formatFileSize } from '../../../shared/utils/formatFileSize';

const ACCEPTED_BOOK_FILES = '.epub,.txt,.pdf,.mobi,.cbz,.zip,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif,.jfif';

interface ReplaceBookFileDialogProps {
  errorMessage?: string;
  isOpen: boolean;
  isReplacing: boolean;
  onCancel: () => void;
  onReplace: (file: File, keepProgress: boolean) => Promise<void> | void;
  progress: number;
}

export function ReplaceBookFileDialog({ errorMessage, isOpen, isReplacing, onCancel, onReplace, progress }: ReplaceBookFileDialogProps) {
  const dialogRef = useDialogFocus<HTMLElement>(isOpen, onCancel, !isReplacing);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [keepProgress, setKeepProgress] = useState(true);
  const [validationMessage, setValidationMessage] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setFile(null);
      setKeepProgress(true);
      setValidationMessage('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleFileChange = (nextFile?: File) => {
    if (isReplacing || !nextFile) return;
    if (nextFile.size <= 0) {
      setFile(null);
      setValidationMessage('这个文件是空的，请重新选择');
      return;
    }
    if (!/\.(epub|txt|pdf|mobi|cbz|zip|jpe?g|png|webp|gif|bmp|avif|jfif)$/i.test(nextFile.name)) {
      setFile(null);
      setValidationMessage('暂不支持这个文件格式');
      return;
    }
    setFile(nextFile);
    setValidationMessage('');
  };

  return (
    <ViewportDialogPortal className="z-[100] grid place-items-center bg-stone-950/55 backdrop-blur-sm" onClick={isReplacing ? undefined : onCancel}>
      <section
        aria-labelledby="replace-book-file-title"
        aria-modal="true"
        className="book-management-dialog book-action-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-[520px] overflow-y-auto rounded-2xl bg-white p-5 shadow-[0_26px_90px_rgba(28,22,22,0.28)] reader-scrollbar sm:p-6 dark:bg-night"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="replace-book-file-title">替换书籍文件</h2>
            <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">换成新的译本，原书架记录和累计阅读时长不变。</p>
          </div>
          <button aria-label="关闭替换书籍文件" className="book-dialog-close grid h-9 w-9 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-night-ink" disabled={isReplacing} onClick={onCancel} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>

        <input accept={ACCEPTED_BOOK_FILES} className="sr-only" disabled={isReplacing} onChange={(event) => {
          const selectedFile = event.target.files?.[0];
          // Allow a revised file from the same path to trigger change again.
          event.target.value = '';
          handleFileChange(selectedFile);
        }} ref={inputRef} tabIndex={-1} type="file" />
        <button
          className="book-file-picker mt-5 flex min-h-24 w-full items-center gap-4 rounded-xl border border-dashed border-stone-300 px-4 py-4 text-left transition hover:border-accent/60 hover:bg-pink-50/40 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:hover:border-peach/50 dark:hover:bg-white/[0.04]"
          disabled={isReplacing}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <span className="book-dialog-symbol grid h-11 w-11 shrink-0 place-items-center rounded-full bg-pink-50 text-accent dark:bg-white/[0.07] dark:text-peach">
            <FileUp className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium [overflow-wrap:anywhere] text-stone-900 dark:text-night-ink">{file?.name ?? '选择新的书籍文件'}</span>
            <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">{file ? formatFileSize(file.size) : '支持 EPUB、TXT、PDF、MOBI、CBZ、ZIP 和图片'}</span>
          </span>
        </button>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-stone-100/70 px-4 py-3.5 dark:bg-white/[0.045]">
          <input checked={keepProgress} className="mt-0.5 h-4 w-4 shrink-0 rounded border-stone-300 accent-pink-500" disabled={isReplacing} onChange={(event) => setKeepProgress(event.target.checked)} type="checkbox" />
          <span>
            <span className="block text-sm font-medium text-stone-900 dark:text-night-ink">保留阅读进度百分比</span>
            <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">会清除旧章节、页码和 CFI 定位，再按百分比从新译本附近继续。</span>
          </span>
        </label>

        <div className="mt-4 space-y-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
          <p className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />保留书名资料、收藏、评分、公开状态和自定义封面</p>
          <p className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />保留所有阅读者的书签和备注；旧定位将失效，可在阅读器中重新定位。解析失败会恢复旧版本。</p>
        </div>

        {isReplacing && (
          <div className="mt-5" aria-label="替换上传进度" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(progress)} role="progressbar">
            <div className="h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-white/10">
              <div className="h-full rounded-full bg-pink-500 transition-[width] duration-300" style={{ width: `${Math.max(4, Math.min(100, progress))}%` }} />
            </div>
            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{progress >= 72 ? '文件已上传，服务器正在解析新版本...' : `正在上传 ${Math.round(progress)}%`}</p>
          </div>
        )}

        {(validationMessage || errorMessage) && <p role="alert" className="mt-4 whitespace-pre-wrap text-sm text-red-500 [overflow-wrap:anywhere]">{validationMessage || errorMessage}</p>}
        <div className="book-action-footer mt-6 grid gap-2 sm:grid-cols-2">
          <Button className="w-full" disabled={isReplacing} onClick={onCancel} variant="secondary">取消</Button>
          <Button className="w-full" disabled={!file || isReplacing || Boolean(validationMessage)} icon={isReplacing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} onClick={() => file && void onReplace(file, keepProgress)}>
            {isReplacing ? '正在替换...' : '确认替换'}
          </Button>
        </div>
      </section>
    </ViewportDialogPortal>
  );
}
