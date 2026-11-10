import { AlignLeft, Save, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { cn } from '../../../shared/utils/cn';
import type { AppendBookChapterInput, EditableBookChapterContent } from '../../books/services/bookService';
import type { ReaderTheme } from '../../reader/types/reader';
import { formatPastedChapterText } from '../services/chapterTextFormatting';
import { useChapterDraft } from '../hooks/useChapterDraft';
import { ChapterDraftStatus } from './ChapterDraftStatus';

interface EditChapterDialogProps {
  bookId: string;
  chapter: EditableBookChapterContent | null;
  errorMessage?: string;
  hasImages?: boolean;
  isSaving: boolean;
  readerTheme?: ReaderTheme;
  onCancel: () => void;
  onDiscardDraft: () => void;
  onDelete?: () => Promise<boolean> | boolean;
  onSave: (input: AppendBookChapterInput, revision: string) => Promise<boolean> | boolean;
}

export function EditChapterDialog({ bookId, chapter, errorMessage, hasImages = false, isSaving, readerTheme, onCancel, onDiscardDraft, onDelete, onSave }: EditChapterDialogProps) {
  const isOpen = chapter !== null;
  const dialogRef = useDialogFocus<HTMLElement>(isOpen, onCancel, !isSaving);
  const draft = useChapterDraft(bookId, chapter?.index ?? 0, isOpen);
  const content = draft.value?.content ?? chapter?.content ?? '';
  const title = draft.value?.title ?? chapter?.title ?? '';
  const [validationMessage, setValidationMessage] = useState('');
  const [formattingMessage, setFormattingMessage] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const focusBody = () => bodyRef.current?.focus({ preventScroll: true });
  useEffect(() => {
    setValidationMessage('');
    setFormattingMessage('');
  }, [chapter?.index, bookId]);

  if (!chapter) return null;
  const revision = draft.value?.baseRevision ?? chapter.revision;
  const stale = revision !== chapter.revision;
  const changeDraft = (patch: Partial<{ content: string; title: string }>) => draft.store.update({ content, title, preparedBody: true, baseRevision: revision, ...patch });

  const applyFormatting = (nextContent = content) => {
    const formatted = formatPastedChapterText(nextContent, title, { extractTitle: 'matching' });
    changeDraft({ content: formatted.content });
    setFormattingMessage(formatted.paragraphCount ? `已整理为 ${formatted.paragraphCount} 段` : '没有可整理的正文');
    setValidationMessage('');
  };

  const handleSubmit = async () => {
    if (isSaving) return;
    if (!content.trim()) {
      setValidationMessage('章节正文不能为空');
      return;
    }
    setValidationMessage('');
    if (await onSave({ content, title: title.trim() || chapter.title }, revision)) draft.store.clearIfVersion(draft.version);
  };

  const handleDelete = async () => {
    if (isSaving || stale || !onDelete || !window.confirm(`确定删除“${chapter.title}”吗？\n\n正文会从服务器原书文件中删除，后续章节、阅读进度和有效书签编号会自动前移。本章的书签和备注会保留，但需要重新定位。此操作不能撤销。`)) return;
    if (await onDelete()) draft.store.clearIfVersion(draft.version);
  };

  return (
    <ViewportDialogPortal className="z-[100] grid items-start justify-items-center bg-stone-950/60 backdrop-blur-sm sm:items-center" onClick={isSaving ? undefined : onCancel}>
      <section aria-busy={isSaving} aria-labelledby="edit-chapter-title" aria-modal="true" className={cn('chapter-editor-dialog flex max-h-[calc(var(--dialog-viewport-height,100dvh)-2.5rem)] min-w-0 w-full max-w-[760px] flex-col overflow-hidden rounded-lg bg-white p-5 shadow-[0_26px_90px_rgba(28,22,22,0.32)] dark:bg-[#1d1722] sm:p-6', readerTheme && `chapter-editor-reader reader-theme-${readerTheme}`)} onClick={(event) => event.stopPropagation()} ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-semibold text-stone-950 dark:text-night-ink sm:text-2xl" id="edit-chapter-title">编辑章节</h2>
            <p className="chapter-editor-meta mt-1 text-sm text-stone-500 dark:text-night-soft">第 {chapter.index} 章 · 保存后会直接更新服务器上的原书文件</p>
          </div>
          <button aria-label="关闭章节编辑" className="chapter-editor-tool grid h-11 w-11 shrink-0 place-items-center rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:text-night-soft dark:hover:bg-white/10 dark:hover:text-night-ink" disabled={isSaving} onClick={onCancel} type="button"><X className="h-4 w-4" /></button>
        </div>

        <div className="chapter-editor-fields mt-5 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1 reader-scrollbar">
          <label className="grid gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            章节名
            <input className="min-h-11 min-w-0 w-full rounded-md border border-stone-200 bg-white px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]" disabled={isSaving} maxLength={255} onChange={(event) => changeDraft({ title: event.target.value })} value={title} />
          </label>
          <label className="grid gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            <span className="flex items-center justify-between gap-3"><span>章节正文</span><span className="chapter-editor-meta text-xs font-normal tabular-nums text-stone-500 dark:text-night-soft">{content.trim().length.toLocaleString()} 字</span></span>
            <textarea data-dialog-autofocus className="min-h-[220px] min-w-0 w-full resize-y rounded-md border border-stone-200 bg-white px-4 py-3 font-display text-[16px] leading-8 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04] sm:min-h-[300px]" disabled={isSaving} onChange={(event) => { changeDraft({ content: event.target.value }); setFormattingMessage(''); setValidationMessage(''); }} ref={bodyRef} value={content} />
          </label>
          <div className="-mt-2 flex min-h-9 flex-wrap items-center justify-between gap-2">
            <span aria-live="polite" className="chapter-editor-meta text-xs text-stone-500 dark:text-night-soft">{hasImages ? '正文中的 [[AISU_CHAPTER_IMAGE:编号]] 是插画位置，请勿删除' : formattingMessage}</span>
            <button className="chapter-editor-tool inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:text-night-soft dark:hover:bg-white/[0.07] dark:hover:text-night-ink" disabled={isSaving || !content.trim()} onClick={() => applyFormatting()} type="button"><AlignLeft className="h-3.5 w-3.5" />重新整理</button>
          </div>
        </div>

        {(validationMessage || errorMessage) && <p role="alert" className="chapter-editor-error mt-4 shrink-0 rounded-md bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-300">{validationMessage || errorMessage}</p>}
        <ChapterDraftStatus disabled={isSaving} draft={draft} stale={stale} onDiscard={() => { setValidationMessage(''); setFormattingMessage(''); onDiscardDraft(); focusBody(); }} onRetrySuccess={focusBody} />
        <div className="mt-5 flex shrink-0 flex-col-reverse gap-3 sm:flex-row sm:items-center">
          {onDelete && <Button className="chapter-editor-delete sm:mr-auto" disabled={isSaving || stale} icon={<Trash2 className="h-4 w-4" />} onClick={handleDelete} variant="ghost">删除本话</Button>}
          <Button className="chapter-editor-cancel" disabled={isSaving} onClick={onCancel} variant="secondary">取消</Button>
          <Button className="chapter-editor-save" disabled={isSaving || !content.trim() || !title.trim()} icon={<Save className="h-4 w-4" />} onClick={handleSubmit}>{isSaving ? '正在修改原书...' : '保存到原书文件'}</Button>
        </div>
      </section>
    </ViewportDialogPortal>
  );
}
