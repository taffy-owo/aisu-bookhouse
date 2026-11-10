import { AlignLeft, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import type { AppendBookChapterInput } from '../../books/services/bookService';
import { formatPastedChapterText } from '../services/chapterTextFormatting';
import { useChapterDraft } from '../hooks/useChapterDraft';
import { ChapterDraftStatus } from './ChapterDraftStatus';

interface AppendChapterDialogProps {
  bookId: string;
  bookTitle: string;
  errorMessage?: string;
  existingChapterCount: number;
  isOpen: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onDiscardDraft: () => void;
  onSave: (input: AppendBookChapterInput) => Promise<boolean> | boolean;
}

export function AppendChapterDialog({ bookId, bookTitle, errorMessage, existingChapterCount, isOpen, isSaving, onCancel, onDiscardDraft, onSave }: AppendChapterDialogProps) {
  const dialogRef = useDialogFocus<HTMLElement>(isOpen, onCancel, !isSaving);
  const draft = useChapterDraft(bookId, 'append', isOpen);
  const content = draft.value?.content ?? '';
  const title = draft.value?.title ?? '';
  const [validationMessage, setValidationMessage] = useState('');
  const [formattingMessage, setFormattingMessage] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const focusBody = () => bodyRef.current?.focus({ preventScroll: true });
  useEffect(() => { setValidationMessage(''); setFormattingMessage(''); }, [bookId, isOpen]);
  const preparedBody = draft.value?.preparedBody ?? false;
  const changeDraft = (patch: Partial<{ content: string; title: string; preparedBody: boolean }>) => draft.store.update({ content, title, preparedBody, ...patch });

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (isSaving) return;
    const formatted = formatPastedChapterText(content, title, { extractTitle: !preparedBody });
    if (!formatted.content) {
      setValidationMessage('请粘贴章节正文');
      return;
    }
    setValidationMessage('');
    if (await onSave({ content: formatted.content, contentIsBody: true, title: title.trim() || formatted.detectedTitle })) draft.store.clearIfVersion(draft.version);
  };

  const applyFormatting = (nextContent = content, extractTitle = !preparedBody) => {
    const formatted = formatPastedChapterText(nextContent, title, { extractTitle });
    changeDraft({ content: formatted.content, title: title.trim() ? title : formatted.detectedTitle || title, preparedBody: true });
    setFormattingMessage(formatted.paragraphCount ? `已整理为 ${formatted.paragraphCount} 段` : '没有可整理的正文');
    setValidationMessage('');
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = event.clipboardData.getData('text');
    if (!pastedText) return;
    const target = event.currentTarget;
    // Inserting a fragment must not reformat or re-detect the existing draft.
    if (content.trim() && (target.selectionStart !== 0 || target.selectionEnd !== content.length)) return;
    event.preventDefault();
    applyFormatting(pastedText, true);
  };

  return (
    <ViewportDialogPortal className="z-[100] grid items-start justify-items-center bg-stone-950/60 backdrop-blur-sm sm:items-center" onClick={isSaving ? undefined : onCancel}>
      <section
        aria-labelledby="append-chapter-title"
        aria-modal="true"
        className="chapter-append-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] min-w-0 w-full max-w-[720px] overflow-y-auto rounded-lg bg-shell p-5 shadow-[0_26px_90px_rgba(28,22,22,0.32)] reader-scrollbar dark:bg-[#1d1722] sm:p-6"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-semibold text-stone-950 dark:text-night-ink sm:text-2xl" id="append-chapter-title">追加章节</h2>
            <p className="mt-1 truncate text-sm text-stone-400">{bookTitle} · 接在第 {existingChapterCount} 章之后</p>
          </div>
          <button aria-label="关闭追加章节" className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-night-ink" disabled={isSaving} onClick={onCancel} type="button"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="grid gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            <span className="flex items-center justify-between gap-3"><span>章节正文</span><span className="text-xs font-normal tabular-nums text-stone-400">{content.trim().length.toLocaleString()} 字</span></span>
            <textarea
              data-dialog-autofocus
              className="min-h-[min(42dvh,300px)] min-w-0 w-full resize-y rounded-md border border-stone-200 bg-shell px-4 py-3 font-display text-[16px] leading-8 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04] sm:min-h-[min(48dvh,390px)]"
              disabled={isSaving}
              onChange={(event) => {
                changeDraft({ content: event.target.value, preparedBody: event.target.value.trim() ? preparedBody : false });
                setFormattingMessage('');
                setValidationMessage('');
              }}
              onPaste={handlePaste}
              ref={bodyRef}
              placeholder="直接粘贴翻译好的正文。第一行是“第×章”时会自动作为章节名。"
              value={content}
            />
          </label>
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 -mt-2">
            <span aria-live="polite" className="text-xs text-stone-400">{formattingMessage}</span>
            <button className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:text-stone-400 dark:hover:bg-white/[0.07] dark:hover:text-night-ink" disabled={isSaving || !content.trim()} onClick={() => applyFormatting()} type="button">
              <AlignLeft className="h-3.5 w-3.5" />整理排版
            </button>
          </div>
          <label className="grid gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            章节名 <span className="font-normal text-stone-400">可留空</span>
            <input
              className="min-h-11 min-w-0 w-full rounded-md border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
              disabled={isSaving}
              maxLength={255}
              onChange={(event) => changeDraft({ title: event.target.value })}
              placeholder={`留空则自动识别或生成“第 ${existingChapterCount + 1} 章”`}
              value={title}
            />
          </label>
        </div>

        {(validationMessage || errorMessage) && <p role="alert" className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-300">{validationMessage || errorMessage}</p>}
        <ChapterDraftStatus disabled={isSaving} draft={draft} onDiscard={() => { setValidationMessage(''); setFormattingMessage(''); onDiscardDraft(); focusBody(); }} onRetrySuccess={focusBody} />
        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button disabled={isSaving} onClick={onCancel} variant="secondary">取消</Button>
          <Button disabled={isSaving || !content.trim()} icon={<Plus className="h-4 w-4" />} onClick={handleSubmit}>{isSaving ? '追加中...' : `追加为第 ${existingChapterCount + 1} 章`}</Button>
        </div>
      </section>
    </ViewportDialogPortal>
  );
}
