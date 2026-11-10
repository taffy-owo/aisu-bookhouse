import { ExternalLink, Link2, LoaderCircle, Save, Sparkles, Unlink, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { cn } from '../../../shared/utils/cn';
import type { Book } from '../../books';
import type { BookUpdateInput } from '../../books/services/bookService';
import { getWorkSourceMetadata, looksLikeSupportedSourceLink, sourceTranslationNotice, type WorkSourceMetadata } from '../../uploads/services/sourceMetadataService';
import { applySourceMetadata, getSourceMetadataStats } from '../services/sourceMetadataImport';

interface SourceLinkDialogProps {
  book: Book;
  errorMessage?: string;
  isOpen: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (input: BookUpdateInput) => Promise<void> | void;
  onDraftChange?: () => void;
}

export function SourceLinkDialog({ book, errorMessage, isOpen, isSaving, onCancel, onSave, onDraftChange }: SourceLinkDialogProps) {
  const dialogRef = useDialogFocus<HTMLElement>(isOpen, onCancel, !isSaving);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [metadata, setMetadata] = useState<WorkSourceMetadata | null>(null);
  const [publicationStatus, setPublicationStatus] = useState(book.publicationStatus ?? 'completed');
  const [sourceUrl, setSourceUrl] = useState(book.sourceUrl ?? '');
  const requestIdRef = useRef(0);
  const lookupControllerRef = useRef<AbortController | null>(null);
  const editingBookRef = useRef<string | null>(null);
  const hasManualStatusRef = useRef(false);
  const sourceHostname = useMemo(() => getSourceHostname(sourceUrl), [sourceUrl]);
  const cancelLookup = useCallback(() => {
    requestIdRef.current += 1;
    lookupControllerRef.current?.abort();
    lookupControllerRef.current = null;
  }, []);

  useEffect(() => {
    if (!isOpen) {
      editingBookRef.current = null;
      cancelLookup();
      return;
    }
    if (editingBookRef.current === book.id) return;
    editingBookRef.current = book.id;
    cancelLookup();
    hasManualStatusRef.current = false;
    setIsLookingUp(false);
    setLookupError('');
    setMetadata(null);
    setPublicationStatus(book.publicationStatus ?? 'completed');
    setSourceUrl(book.sourceUrl ?? '');
  }, [book, cancelLookup, isOpen]);

  useEffect(() => () => {
    editingBookRef.current = null;
    cancelLookup();
  }, [cancelLookup]);

  if (!isOpen) return null;

  const handleLookup = async (rawUrl = sourceUrl) => {
    if (isSaving) return;
    const url = rawUrl.trim();
    if (!url) {
      setLookupError('请先粘贴原作链接');
      return;
    }
    cancelLookup();
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    lookupControllerRef.current = controller;
    setIsLookingUp(true);
    setLookupError('');
    setMetadata(null);
    onDraftChange?.();
    try {
      const result = await getWorkSourceMetadata(url, controller.signal);
      if (requestIdRef.current !== requestId || controller.signal.aborted) return;
      setMetadata(result);
      if (!hasManualStatusRef.current) setPublicationStatus(result.publication_status);
      setSourceUrl(result.source_url);
    } catch (error) {
      if (requestIdRef.current !== requestId || controller.signal.aborted) return;
      setLookupError(error instanceof Error ? error.message : '原作资料读取失败');
    } finally {
      if (requestIdRef.current === requestId && !controller.signal.aborted) setIsLookingUp(false);
      if (lookupControllerRef.current === controller) lookupControllerRef.current = null;
    }
  };

  const handleSave = () => {
    if (isSaving || isLookingUp || lookupControllerRef.current) return;
    if (!sourceUrl.trim()) {
      void onSave({ autoTranslateUpdates: false, sourceUrl: null });
      return;
    }
    if (!metadata) {
      void onSave({ autoTranslateUpdates: publicationStatus === 'ongoing', publicationStatus, sourceUrl: sourceUrl.trim() });
      return;
    }

    const imported = applySourceMetadata({
      author: book.author,
      description: book.description,
      publicationStatus,
      sourceUrl,
      tags: book.tags,
      title: book.title,
    }, metadata);
    void onSave({
      autoTranslateUpdates: publicationStatus === 'ongoing',
      author: imported.author,
      description: imported.description,
      publicationStatus,
      sourceCharacterCount: metadata.character_count,
      sourceEpisodeCount: metadata.episode_count,
      sourceScheduleLabel: metadata.schedule_label,
      sourceScheduleTime: metadata.schedule_time,
      sourceScheduleTimezone: metadata.schedule_timezone === 'Asia/Tokyo' ? 'Asia/Tokyo' : null,
      sourceUrl: imported.sourceUrl,
      tags: imported.tags,
      title: imported.title,
    });
  };

  return (
    <ViewportDialogPortal className="z-[100] grid items-start justify-items-center bg-stone-950/55 backdrop-blur-sm sm:items-center" onClick={isSaving ? undefined : onCancel}>
      <section
        aria-labelledby="source-link-dialog-title"
        aria-modal="true"
        className="book-management-dialog source-link-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-[620px] overflow-y-auto rounded-[24px] bg-white p-5 shadow-[0_26px_90px_rgba(28,22,22,0.28)] reader-scrollbar dark:bg-night"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-accent">原作与连载</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="source-link-dialog-title">{book.sourceUrl ? '更新原作关联' : '关联原作'}</h2>
          </div>
          <button aria-label="关闭原作关联" className="book-dialog-close grid h-11 w-11 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-white/10 dark:hover:text-night-ink" disabled={isSaving} onClick={onCancel} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <div className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            <label className="inline-flex items-center gap-2" htmlFor="source-link-url"><Link2 className="h-4 w-4 text-accent" />原作链接</label>
            <div className="book-dialog-source-entry flex min-w-0 flex-col gap-2 sm:flex-row">
              <input
                data-dialog-autofocus
                className="min-h-11 min-w-0 w-full flex-1 rounded-xl border border-stone-200 bg-white px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                disabled={isSaving}
                id="source-link-url"
                maxLength={1000}
                onChange={(event) => {
                  cancelLookup();
                  setIsLookingUp(false);
                  setSourceUrl(event.target.value);
                  setMetadata(null);
                  setLookupError('');
                  onDraftChange?.();
                }}
                onPaste={(event) => {
                  const pastedUrl = event.clipboardData.getData('text').trim();
                  if (!isSaving && looksLikeSupportedSourceLink(pastedUrl)) {
                    event.preventDefault();
                    setSourceUrl(pastedUrl);
                    void handleLookup(pastedUrl);
                  }
                }}
                placeholder="粘贴 Kakuyomu 等作品链接"
                type="url"
                value={sourceUrl}
              />
              <Button className="shrink-0 sm:min-w-[118px]" disabled={isSaving || isLookingUp || !sourceUrl.trim()} icon={isLookingUp ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} onClick={() => void handleLookup()} variant="secondary">
                {isLookingUp ? '读取中...' : metadata ? '重新读取' : '读取资料'}
              </Button>
            </div>
            {lookupError && <span role="alert" className="whitespace-pre-wrap text-xs font-normal text-red-500 [overflow-wrap:anywhere] dark:text-red-400">{lookupError}</span>}
            {sourceHostname && !metadata && (
              <a className="inline-flex w-fit items-center gap-1.5 text-xs font-normal text-accent hover:text-accent-deep dark:text-peach" href={sourceUrl} rel="noreferrer" target="_blank">
                打开 {sourceHostname} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>

          {metadata && (
            <div aria-live="polite" className="min-w-0 rounded-xl bg-emerald-50 px-4 py-3 [overflow-wrap:anywhere] dark:bg-emerald-950/20">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="min-w-0 max-w-full text-sm font-medium text-emerald-800 [overflow-wrap:anywhere] dark:text-emerald-300">{metadata.title}</p>
                {metadata.translation_status === 'translated' && <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">AI 已翻译</span>}
              </div>
              {metadata.original_title && <p className="mt-0.5 break-words text-xs text-emerald-700/65 dark:text-emerald-400/65">原题：{metadata.original_title}</p>}
              <p className="mt-1 text-xs text-emerald-700/75 dark:text-emerald-400/80">{metadata.author} · {getSourceMetadataStats(metadata)}</p>
              {metadata.schedule_label && <p className="mt-1 text-xs text-emerald-700/75 dark:text-emerald-400/80">源站更新标注：{metadata.schedule_label}{metadata.schedule_time ? '，保存后按该时间检查' : ''}</p>}
              {metadata.episodes?.length ? <p className="mt-1 text-xs text-emerald-700/75 dark:text-emerald-400/80">已读取 {metadata.episodes.length} 个源站目录标题，保存后自动校正占位章节名</p> : null}
              {publicationStatus === 'ongoing' && <p className="mt-1 text-xs text-emerald-700/75 dark:text-emerald-400/80">检测到新话后自动翻译，完成后在通知栏提醒；你确认接受后才会加入原书</p>}
              {metadata.translation_status === 'unavailable' && <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-300">{sourceTranslationNotice(metadata)}</p>}
              <a className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-900 dark:text-emerald-300" href={metadata.source_url} rel="noreferrer" target="_blank">
                查看原作 <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}

          <div className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            <span>连载状态</span>
            <div aria-label="连载状态" className="grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 dark:bg-white/[0.06]" role="group">
              {([
                ['ongoing', '连载中'],
                ['completed', '已完结'],
              ] as const).map(([value, label]) => {
                const isActive = publicationStatus === value;
                return (
                  <button
                    aria-pressed={isActive}
                    className={cn(
                      'min-h-11 rounded-lg px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-accent/25',
                      isActive
                        ? 'bg-white text-accent shadow-sm dark:bg-white/[0.12] dark:text-peach'
                        : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-night-ink',
                    )}
                    disabled={isSaving}
                    key={value}
                    onClick={() => {
                      hasManualStatusRef.current = true;
                      setPublicationStatus(value);
                      onDraftChange?.();
                    }}
                    type="button"
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

        </div>

        {errorMessage && <p role="alert" className="mt-4 whitespace-pre-wrap rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 [overflow-wrap:anywhere] dark:bg-red-950/30 dark:text-red-300">{errorMessage}</p>}
        <div className="book-dialog-source-actions mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {book.sourceUrl && (
              <Button disabled={isSaving} icon={<Unlink className="h-4 w-4" />} onClick={() => {
                cancelLookup();
                setIsLookingUp(false);
                setSourceUrl('');
                setMetadata(null);
                setLookupError('');
                onDraftChange?.();
              }} variant="ghost">移除关联</Button>
            )}
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <Button disabled={isSaving} onClick={onCancel} variant="secondary">取消</Button>
            <Button disabled={isSaving || isLookingUp || (!sourceUrl.trim() && !book.sourceUrl)} icon={<Save className="h-4 w-4" />} onClick={handleSave}>
              {isSaving ? '保存中...' : book.sourceUrl && !sourceUrl.trim() ? '确认移除' : '保存关联'}
            </Button>
          </div>
        </div>
      </section>
    </ViewportDialogPortal>
  );
}

function getSourceHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
