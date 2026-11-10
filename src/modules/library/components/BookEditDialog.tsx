import { Link2, LoaderCircle, Save, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { StarRating } from '../../../shared/components/StarRating';
import type { Book } from '../../books';
import { bookLanguageLabels, getBookLanguageSetting, type BookLanguageSetting } from '../../books/services/bookLanguagePreferences';
import type { BookUpdateInput } from '../../books/services/bookService';
import { getWorkSourceMetadata, looksLikeSupportedSourceLink, sourceTranslationNotice, type WorkSourceMetadata } from '../../uploads/services/sourceMetadataService';
import { getBookEditChanges } from '../services/bookEditChanges';
import { applySourceMetadata, getSourceMetadataStats } from '../services/sourceMetadataImport';

interface BookEditDialogProps {
  book: Book;
  errorMessage?: string;
  isOpen: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (input: BookUpdateInput) => Promise<void> | void;
  onDraftChange?: () => void;
}

export function BookEditDialog({ book, errorMessage, isOpen, isSaving, onCancel, onSave, onDraftChange }: BookEditDialogProps) {
  const dialogRef = useDialogFocus<HTMLElement>(isOpen, onCancel, !isSaving);
  const [initialBook, setInitialBook] = useState(book);
  const [author, setAuthor] = useState(book.author);
  const [description, setDescription] = useState(book.description);
  const [language, setLanguage] = useState<BookLanguageSetting>(getBookLanguageSetting(book));
  const [isLookingUpSource, setIsLookingUpSource] = useState(false);
  const [publicationStatus, setPublicationStatus] = useState(book.publicationStatus ?? 'completed');
  const [rating, setRating] = useState(book.rating ?? 0);
  const [seriesKind, setSeriesKind] = useState(book.seriesKind ?? '');
  const [seriesOrderText, setSeriesOrderText] = useState(book.seriesOrder === undefined ? '' : String(book.seriesOrder));
  const [seriesTitle, setSeriesTitle] = useState(book.seriesTitle ?? '');
  const [sourceUrl, setSourceUrl] = useState(book.sourceUrl ?? '');
  const [sourceLookupError, setSourceLookupError] = useState('');
  const [sourceMetadata, setSourceMetadata] = useState<WorkSourceMetadata | null>(null);
  const [tagsText, setTagsText] = useState(book.tags.join('，'));
  const [title, setTitle] = useState(book.title);
  const [validationMessage, setValidationMessage] = useState('');
  const editingBookRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const authorInputRef = useRef<HTMLInputElement | null>(null);
  const seriesOrderInputRef = useRef<HTMLInputElement | null>(null);
  const [validationField, setValidationField] = useState<'title' | 'author' | 'seriesOrder' | null>(null);
  const sourceLookupRequestRef = useRef(0);
  const sourceLookupControllerRef = useRef<AbortController | null>(null);
  const manualEditRevisionsRef = useRef({ author: 0, description: 0, publicationStatus: 0, tags: 0 });
  const tags = useMemo(() => parseTags(tagsText), [tagsText]);

  useEffect(() => {
    if (!isOpen) {
      editingBookRef.current = null;
      sourceLookupRequestRef.current += 1;
      sourceLookupControllerRef.current?.abort();
      sourceLookupControllerRef.current = null;
      return;
    }

    if (editingBookRef.current === book.id) return;
    editingBookRef.current = book.id;
    sourceLookupRequestRef.current += 1;
    sourceLookupControllerRef.current?.abort();
    sourceLookupControllerRef.current = null;
    manualEditRevisionsRef.current = { author: 0, description: 0, publicationStatus: 0, tags: 0 };

    setInitialBook(book);
    setAuthor(book.author);
    setDescription(book.description);
    setLanguage(getBookLanguageSetting(book));
    setPublicationStatus(book.publicationStatus ?? 'completed');
    setRating(book.rating ?? 0);
    setSeriesKind(book.seriesKind ?? '');
    setSeriesOrderText(book.seriesOrder === undefined ? '' : String(book.seriesOrder));
    setSeriesTitle(book.seriesTitle ?? '');
    setSourceUrl(book.sourceUrl ?? '');
    setSourceLookupError('');
    setSourceMetadata(null);
    setIsLookingUpSource(false);
    setTagsText(book.tags.join('，'));
    setTitle(book.title);
    setValidationMessage('');
    setValidationField(null);
  }, [book, isOpen]);

  useEffect(() => () => {
    editingBookRef.current = null;
    sourceLookupRequestRef.current += 1;
    sourceLookupControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const isValid = (validationField === 'title' && Boolean(title.trim()))
      || (validationField === 'author' && Boolean(author.trim()))
      || (validationField === 'seriesOrder' && parseSeriesOrder(seriesOrderText) !== undefined);
    if (isValid) {
      setValidationField(null);
      setValidationMessage('');
    }
  }, [author, seriesOrderText, title, validationField]);

  if (!isOpen) {
    return null;
  }

  const handleSourceLookup = async (rawUrl = sourceUrl) => {
    if (isSaving) return;
    const url = rawUrl.trim();
    if (!url) {
      setSourceLookupError('请先粘贴原作链接');
      return;
    }

    const requestId = sourceLookupRequestRef.current + 1;
    sourceLookupRequestRef.current = requestId;
    sourceLookupControllerRef.current?.abort();
    const controller = new AbortController();
    sourceLookupControllerRef.current = controller;
    const revisions = { ...manualEditRevisionsRef.current };
    setIsLookingUpSource(true);
    setSourceLookupError('');
    setSourceMetadata(null);
    onDraftChange?.();
    try {
      const metadata = await getWorkSourceMetadata(url, controller.signal);
      if (sourceLookupRequestRef.current !== requestId || controller.signal.aborted) return;
      const imported = applySourceMetadata({ author, description, publicationStatus, sourceUrl, tags, title }, metadata);
      // A field edited away and back still represents a newer user decision.
      if (manualEditRevisionsRef.current.author === revisions.author) setAuthor(imported.author);
      if (manualEditRevisionsRef.current.description === revisions.description) setDescription(imported.description);
      if (manualEditRevisionsRef.current.publicationStatus === revisions.publicationStatus) setPublicationStatus(imported.publicationStatus);
      setSourceUrl((current) => current === sourceUrl || current === url ? imported.sourceUrl : current);
      if (manualEditRevisionsRef.current.tags === revisions.tags) setTagsText(imported.tags.join('，'));
      setSourceMetadata(metadata);
      setSourceLookupError(sourceTranslationNotice(metadata));
    } catch (error) {
      if (sourceLookupRequestRef.current !== requestId || controller.signal.aborted) return;
      setSourceLookupError(error instanceof Error ? error.message : '原作资料读取失败');
    } finally {
      if (sourceLookupRequestRef.current === requestId) setIsLookingUpSource(false);
      if (sourceLookupControllerRef.current === controller) sourceLookupControllerRef.current = null;
    }
  };

  const handleSubmit = () => {
    if (isSaving || isLookingUpSource || sourceLookupControllerRef.current) return;
    const nextTitle = title.trim();
    const nextAuthor = author.trim();
    if (!nextTitle) {
      setValidationMessage('书名不能为空');
      setValidationField('title');
      titleInputRef.current?.focus();
      return;
    }
    if (!nextAuthor) {
      setValidationMessage('作者不能为空');
      setValidationField('author');
      authorInputRef.current?.focus();
      return;
    }
    const nextSeriesOrder = parseSeriesOrder(seriesOrderText);
    if (nextSeriesOrder === undefined) {
      setValidationMessage('系列顺序必须是数字');
      setValidationField('seriesOrder');
      seriesOrderInputRef.current?.focus();
      return;
    }

    setValidationMessage('');
    setValidationField(null);
    void onSave(getBookEditChanges({
      author: nextAuthor,
      description: description.trim(),
      language,
      publicationStatus,
      rating,
      seriesKind: seriesKind.trim() || null,
      seriesOrder: nextSeriesOrder,
      seriesTitle: seriesTitle.trim() || null,
      sourceUrl: sourceUrl.trim() || null,
      sourceEpisodeCount: sourceMetadata?.episode_count,
      sourceCharacterCount: sourceMetadata?.character_count,
      sourceScheduleLabel: sourceMetadata?.schedule_label,
      sourceScheduleTime: sourceMetadata?.schedule_time,
      sourceScheduleTimezone: sourceMetadata?.schedule_timezone === 'Asia/Tokyo' ? 'Asia/Tokyo' : undefined,
      tags,
      title: nextTitle,
    }, initialBook));
  };

  return (
    <ViewportDialogPortal className="z-[100] grid items-start justify-items-center bg-stone-950/55 backdrop-blur-sm sm:items-center" onClick={isSaving ? undefined : onCancel}>
      <section
        aria-busy={isSaving}
        aria-labelledby="edit-book-title"
        aria-modal="true"
        className="book-management-dialog book-edit-dialog max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-[620px] overflow-y-auto rounded-[28px] border border-white/70 bg-shell p-5 shadow-[0_26px_90px_rgba(28,22,22,0.28)] reader-scrollbar dark:border-white/10 dark:bg-night"
        onClick={(event) => event.stopPropagation()}
        onChange={onDraftChange}
        role="dialog"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink" id="edit-book-title">
              编辑图书资料
            </h2>
          </div>
          <button
            aria-label="关闭编辑图书资料"
            className="book-dialog-close grid h-11 w-11 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-night-ink"
            disabled={isSaving}
            onClick={onCancel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            书名
            <input
              ref={titleInputRef}
              aria-invalid={validationField === 'title'}
              aria-describedby={validationField === 'title' ? 'edit-book-validation' : undefined}
              className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
              disabled={isSaving}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            作者
            <input
              ref={authorInputRef}
              aria-invalid={validationField === 'author'}
              aria-describedby={validationField === 'author' ? 'edit-book-validation' : undefined}
              className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
              disabled={isSaving}
              onChange={(event) => { manualEditRevisionsRef.current.author += 1; setAuthor(event.target.value); }}
              value={author}
            />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            书籍语言
            <select
              className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
              disabled={isSaving}
              onChange={(event) => setLanguage(event.target.value as BookLanguageSetting)}
              value={language}
            >
              <option value="auto">自动识别</option>
              <option value="und">暂不指定</option>
              <option value="zh">中文</option>
              <option value="ja">日文</option>
              <option value="en">英文</option>
              <option value="other">其他</option>
            </select>
            <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
              {language === 'auto'
                ? `当前：${bookLanguageLabels[book.language ?? 'und']}。重新解析时会按正文自动更新。`
                : '手动指定的语言会保留，重新解析不会覆盖。'}
            </span>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            标签
            <input
              className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
              disabled={isSaving}
              onChange={(event) => { manualEditRevisionsRef.current.tags += 1; setTagsText(event.target.value); }}
              placeholder="用逗号分隔，例如：本地上传，安达，百合"
              value={tagsText}
            />
          </label>
          {tags.length > 0 && (
            <div className="book-dialog-tags flex flex-wrap gap-2">
              {tags.map((tag) => (
                <span className="max-w-full rounded-full bg-sakura px-3 py-1 text-xs font-medium text-accent [overflow-wrap:anywhere] dark:bg-plum/45 dark:text-accent-soft" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            我的评分
            <StarRating className="book-dialog-rating" disabled={isSaving} onChange={(value) => { setRating(value); onDraftChange?.(); }} value={rating} />
          </div>
          <div className="book-dialog-source-fields grid min-w-0 gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              作品状态
              <select
                className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                disabled={isSaving}
                onChange={(event) => { manualEditRevisionsRef.current.publicationStatus += 1; setPublicationStatus(event.target.value === 'ongoing' ? 'ongoing' : 'completed'); }}
                value={publicationStatus}
              >
                <option value="ongoing">连载中</option>
                <option value="completed">已完结</option>
              </select>
            </label>
            <div className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              <label className="inline-flex items-center gap-2" htmlFor="edit-book-source-url"><Link2 className="h-4 w-4 text-accent" />原作链接</label>
              <div className="book-dialog-source-entry flex min-w-0 flex-col gap-2 sm:flex-row">
                <input
                  className="min-h-11 min-w-0 w-full flex-1 rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                  disabled={isSaving}
                  id="edit-book-source-url"
                  inputMode="url"
                  maxLength={1000}
                  onChange={(event) => {
                    sourceLookupRequestRef.current += 1;
                    sourceLookupControllerRef.current?.abort();
                    sourceLookupControllerRef.current = null;
                    setIsLookingUpSource(false);
                    setSourceUrl(event.target.value);
                    setSourceMetadata(null);
                    setSourceLookupError('');
                  }}
                  onPaste={(event) => {
                    const pastedUrl = event.clipboardData.getData('text').trim();
                    if (!isSaving && looksLikeSupportedSourceLink(pastedUrl)) {
                      event.preventDefault();
                      setSourceUrl(pastedUrl);
                      void handleSourceLookup(pastedUrl);
                    }
                  }}
                  placeholder="Kakuyomu、成为小说家吧、ハーメルン或 pixiv"
                  type="url"
                  value={sourceUrl}
                />
                <Button
                  className="shrink-0 sm:min-w-[112px]"
                  disabled={isSaving || isLookingUpSource || !sourceUrl.trim()}
                  icon={isLookingUpSource ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  onClick={() => void handleSourceLookup()}
                  variant="secondary"
                >
                  {isLookingUpSource ? '读取中...' : '读取资料'}
                </Button>
              </div>
              {sourceLookupError && <span role="alert" className="whitespace-pre-wrap text-xs font-normal text-red-500 [overflow-wrap:anywhere] dark:text-red-400">{sourceLookupError}</span>}
            </div>
          </div>
          {sourceMetadata && (
            <div aria-live="polite" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm dark:bg-emerald-950/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-emerald-800 [overflow-wrap:anywhere] dark:text-emerald-300">已读取：{sourceMetadata.title}</p>
                  <p className="mt-1 text-xs leading-5 text-emerald-700/75 dark:text-emerald-400/80">
                    {getSourceMetadataStats(sourceMetadata)} · 已填入资料，并保留读取期间的手动修改
                  </p>
                </div>
                {title.trim() !== sourceMetadata.title.trim() && (
                  <button
                    className="shrink-0 text-xs font-medium text-accent dark:text-accent-soft underline decoration-current/30 underline-offset-4 hover:decoration-current"
                    disabled={isSaving}
                    onClick={() => { setTitle(sourceMetadata.title); onDraftChange?.(); }}
                    type="button"
                  >
                    改用原作名
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="book-dialog-series-fields grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)]">
            <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              系列名
              <input
                className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                disabled={isSaving}
                onChange={(event) => setSeriesTitle(event.target.value)}
                placeholder="例如：安达与岛村"
                value={seriesTitle}
              />
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              顺序
              <input
                className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                disabled={isSaving}
                ref={seriesOrderInputRef}
                aria-invalid={validationField === 'seriesOrder'}
                aria-describedby={validationField === 'seriesOrder' ? 'edit-book-validation' : undefined}
                inputMode="decimal"
                onChange={(event) => setSeriesOrderText(event.target.value)}
                placeholder="1"
                value={seriesOrderText}
              />
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              类型
              <input
                className="min-h-11 min-w-0 w-full rounded-2xl border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                disabled={isSaving}
                onChange={(event) => setSeriesKind(event.target.value)}
                placeholder="正篇 / 外传 / SS"
                value={seriesKind}
              />
            </label>
          </div>
          <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
            简介
            <textarea
              className="min-h-32 min-w-0 w-full resize-y rounded-2xl border border-stone-200 bg-shell px-4 py-3 text-sm leading-7 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
              disabled={isSaving}
              onChange={(event) => { manualEditRevisionsRef.current.description += 1; setDescription(event.target.value); }}
              value={description}
            />
          </label>
        </div>

        {(validationMessage || errorMessage) && (
          <p id="edit-book-validation" role="alert" className="mt-4 whitespace-pre-wrap rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600 [overflow-wrap:anywhere] dark:bg-red-950/30 dark:text-red-300">{validationMessage || errorMessage}</p>
        )}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button className="sm:min-w-24" disabled={isSaving} onClick={onCancel} variant="secondary">
            取消
          </Button>
          <Button className="sm:min-w-32" disabled={isSaving || isLookingUpSource} icon={<Save className="h-4 w-4" />} onClick={handleSubmit}>
            {isSaving ? '保存中...' : '保存'}
          </Button>
        </div>
      </section>
    </ViewportDialogPortal>
  );
}

function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)));
}

function parseSeriesOrder(value: string): number | null | undefined {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return null;
  }

  const order = Number(normalizedValue);
  return Number.isFinite(order) ? order : undefined;
}
