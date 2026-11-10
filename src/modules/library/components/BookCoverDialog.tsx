import { ImagePlus, LoaderCircle, RotateCcw, Save, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { BookCover, type Book } from '../../books';

const MAX_COVER_SIZE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface BookCoverDialogProps {
  book: Book;
  errorMessage?: string;
  isOpen: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onRemove: () => Promise<void> | void;
  onSave: (file: File) => Promise<void> | void;
  onSelectionChange?: () => void;
}

type CoverPreview = { file: File; url: string; status: 'loading' | 'ready' | 'error' };

export function BookCoverDialog({ book, errorMessage, isOpen, isSaving, onCancel, onRemove, onSave, onSelectionChange }: BookCoverDialogProps) {
  const dialogRef = useDialogFocus<HTMLElement>(isOpen, onCancel, !isSaving);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CoverPreview | null>(null);
  const [validationMessage, setValidationMessage] = useState('');
  const hasCustomCover = book.coverUrl?.includes('custom=1') ?? false;

  useEffect(() => {
    if (!isOpen) {
      setSelectedFile(null);
      setValidationMessage('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !selectedFile) {
      setPreview(null);
      return undefined;
    }
    const nextPreviewUrl = URL.createObjectURL(selectedFile);
    setPreview({ file: selectedFile, url: nextPreviewUrl, status: 'loading' });
    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [isOpen, selectedFile]);

  if (!isOpen) {
    return null;
  }

  const handleFileChange = (file?: File) => {
    if (!file || isSaving) return;
    onSelectionChange?.();
    if (file.size === 0) {
      setValidationMessage('这张图片是空文件，请重新选择。');
      setSelectedFile(null);
      return;
    }
    const hasAcceptedExtension = /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!ACCEPTED_COVER_TYPES.has(file.type) && !(file.type === '' && hasAcceptedExtension)) {
      setValidationMessage('请选择 JPG、PNG 或 WebP 图片');
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_COVER_SIZE_BYTES) {
      setValidationMessage('封面不能超过 10 MB');
      setSelectedFile(null);
      return;
    }
    setValidationMessage('');
    setSelectedFile(file);
  };
  const activePreview = preview?.file === selectedFile ? preview : null;
  const previewError = activePreview?.status === 'error' ? '无法预览这张图片，请换一张封面' : '';
  const feedbackMessage = validationMessage || previewError || errorMessage;

  return (
    <ViewportDialogPortal className="z-[100] grid place-items-center bg-stone-950/55 backdrop-blur-sm" onClick={isSaving ? undefined : onCancel}>
      <section
        aria-labelledby="book-cover-dialog-title"
        aria-modal="true"
        className="book-management-dialog book-cover-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-[480px] overflow-y-auto rounded-3xl bg-shell p-5 shadow-[0_26px_90px_rgba(28,22,22,0.28)] reader-scrollbar dark:bg-night"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="book-cover-dialog-title">修改封面</h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">保持原图比例，上传后自动压缩。</p>
          </div>
          <button
            aria-label="关闭修改封面"
            className="book-dialog-close grid h-11 w-11 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-night-ink"
            disabled={isSaving}
            onClick={onCancel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex items-center justify-center rounded-2xl bg-stone-100/80 px-5 py-5 dark:bg-white/[0.04]">
          <div aria-busy={Boolean(selectedFile && activePreview?.status !== 'ready' && !previewError)} className="relative flex h-[min(280px,38dvh)] w-full items-center justify-center">
            {selectedFile ? (
              <>
                {activePreview && activePreview.status !== 'error' && <img
                  alt="新封面预览"
                  aria-hidden={activePreview.status !== 'ready'}
                  className={`max-h-full max-w-full rounded-xl object-contain shadow-[3px_8px_22px_rgba(45,35,30,0.24)] ${activePreview.status === 'ready' ? '' : 'opacity-0'}`}
                  key={activePreview.url}
                  onLoad={() => setPreview((current) => current?.url === activePreview.url ? { ...current, status: 'ready' } : current)}
                  onError={() => setPreview((current) => current?.url === activePreview.url ? { ...current, status: 'error' } : current)}
                  src={activePreview.url}
                />}
                {activePreview?.status === 'error' ? (
                  <span className="flex flex-col items-center gap-3 text-sm text-stone-500 dark:text-stone-400"><ImagePlus aria-hidden className="h-7 w-7" />图片无法显示</span>
                ) : activePreview?.status !== 'ready' ? (
                  <span className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400" role="status"><LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />正在检查图片…</span>
                ) : null}
              </>
            ) : (
              <div className="aspect-[0.68] h-full shrink-0"><BookCover book={book} size="md" /></div>
            )}
          </div>
        </div>

        <input
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          aria-label="封面图片"
          className="sr-only"
          disabled={isSaving}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            handleFileChange(file);
          }}
          ref={inputRef}
          tabIndex={-1}
          type="file"
        />
        <div className="book-dialog-cover-actions mt-4 grid gap-2 sm:grid-cols-2">
          <Button className="w-full" disabled={isSaving} icon={<ImagePlus className="h-4 w-4" />} onClick={() => inputRef.current?.click()} variant="secondary">
            {selectedFile ? '重新选择' : '选择图片'}
          </Button>
          <Button aria-busy={isSaving} aria-label="保存封面" className="w-full" disabled={!selectedFile || activePreview?.status !== 'ready' || isSaving || Boolean(validationMessage)} icon={isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} onClick={() => selectedFile && activePreview?.status === 'ready' && void onSave(selectedFile)}>
            {isSaving ? '保存中...' : '保存封面'}
          </Button>
        </div>
        {hasCustomCover && (
          <Button className="mt-2 w-full" disabled={isSaving} icon={<RotateCcw className="h-4 w-4" />} onClick={() => {
            setSelectedFile(null);
            setValidationMessage('');
            onSelectionChange?.();
            void onRemove();
          }} variant="ghost">
            恢复原封面
          </Button>
        )}
        {feedbackMessage && <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-red-500 [overflow-wrap:anywhere]">{feedbackMessage}</p>}
      </section>
    </ViewportDialogPortal>
  );
}
