import { useFocusOwnership } from '../../../shared/hooks/useFocusOwnership';
import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import { Bookmark, BookmarkPlus, Loader2, MapPin, NotebookPen, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getAccountScope } from '../../../shared/api';
import { createReaderNoteDraft } from '../services/readerNoteDraft';
import { isSameReaderNotePosition } from '../utils/readerNotePosition';
import { resolveReaderMarkTarget } from '../utils/readerMarkTarget';
import { cn } from '../../../shared/utils/cn';
import { parseAppDate } from '../../../shared/utils/formatDate';
import { formatReadingProgressPercent } from '../../../shared/utils/readingProgress';
import { useReaderPanelDismiss } from '../hooks/useReaderPanelDismiss';
import type { ReaderEditionSwitch } from '../hooks/useReaderEditionSwitch';
import type { ReaderMark, ReaderMarkCreateInput, ReaderResource, ReaderTheme } from '../types/reader';

interface ReaderMarksPanelProps {
  bookId: string;
  currentMarkInput: ReaderMarkCreateInput;
  error?: string | null;
  hasLoaded?: boolean;
  isLoading?: boolean;
  loadError?: string | null;
  isDark?: boolean;
  isOpen?: boolean;
  theme?: ReaderTheme;
  deletingIds?: string[];
  relocatingIds?: string[];
  isSaving?: boolean;
  marks: ReaderMark[];
  resource?: ReaderResource | null;
  editionSwitch?: ReaderEditionSwitch;
  chapterRefresh?: ReaderEditionSwitch;
  onClose: () => void;
  onCreateMark: (input: ReaderMarkCreateInput) => Promise<boolean> | boolean;
  onDeleteMark: (mark: ReaderMark) => Promise<boolean> | boolean;
  onSelectMark: (mark: ReaderMark) => void | boolean;
  onRelocateMark?: (mark: ReaderMark, position: ReaderMarkCreateInput) => Promise<boolean> | boolean;
  onReload: () => void;
}

export function ReaderMarksPanel({
  bookId,
  currentMarkInput,
  error = null,
  hasLoaded = true,
  isLoading = false,
  loadError = null,
  isDark = false,
  isOpen = true,
  theme = isDark ? 'dark' : 'paper',
  deletingIds = [],
  relocatingIds = [],
  isSaving = false,
  marks,
  resource,
  editionSwitch,
  chapterRefresh,
  onClose,
  onCreateMark,
  onDeleteMark,
  onSelectMark,
  onRelocateMark,
  onReload,
}: ReaderMarksPanelProps) {
  const contentUpdate = editionSwitch ?? chapterRefresh;
  const scope = getAccountScope();
  const draftController = useMemo(() => createReaderNoteDraft(bookId, scope), [bookId, scope]);
  const draft = useSyncExternalStore(draftController.subscribe, draftController.getSnapshot);
  const setDraft = draftController.update;
  const noteDraft = draft.text;
  const [creatingKind, setCreatingKind] = useState<ReaderMark['kind'] | null>(null);
  const creatingRef = useRef(false);
  const wasOpenRef = useRef(false);
  const [localError, setLocalError] = useState('');
  const [message, setMessage] = useState('');
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const ownsFocus = useFocusOwnership();
  const deletingRef = useRef(new Set<string>());
  const relocatingRef = useRef(new Map<string, symbol>());
  const identityRef = useRef(0);
  useLayoutEffect(() => {
    identityRef.current += 1;
    return () => { identityRef.current += 1; };
  }, [scope, bookId, isOpen]);
  const panelRef = useReaderPanelDismiss({ onClose, isOpen });
  const viewportRef = useDialogViewport(isOpen);
  const sortedMarks = useMemo(() => sortMarks(marks), [marks]);
  const trimmedNote = noteDraft.trim();
  const excerptSource = draft.origin?.note ?? currentMarkInput.note;
  const selectedExcerpt = excerptSource?.startsWith('摘录：') ? excerptSource.slice(3) : '';

  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (justOpened && currentMarkInput.note) setDraft((current) => current.text.trim() ? current : { text: currentMarkInput.note ?? '', origin: currentMarkInput });
  }, [currentMarkInput, isOpen, setDraft]);

  useEffect(() => {
    if (isOpen) { setMessage(''); setLocalError(''); }
  }, [isOpen]);

  const handleCreate = async (kind: ReaderMark['kind']) => {
    if (contentUpdate || creatingRef.current || isSaving || (kind === 'note' && !trimmedNote)) return;
    creatingRef.current = true;
    setCreatingKind(kind);
    setLocalError('');
    setMessage('');
    const submittedRevision = draft.revision;
    const revision = identityRef.current;
    const isCurrent = () => identityRef.current === revision && getAccountScope() === scope;
    try {
      const confirmed = await onCreateMark({ ...(kind === 'note' ? draft.origin ?? currentMarkInput : currentMarkInput), kind, note: kind === 'note' ? trimmedNote : '' });
      if (confirmed) {
        if (kind === 'note') draftController.clearIfRevision(submittedRevision);
        if (isCurrent()) setMessage(kind === 'note' ? '备注已保存' : '书签已添加');
      } else if (isCurrent()) setLocalError('尚未保存，请重试；输入的备注已保留。');
    } catch (error) {
      if (isCurrent()) setLocalError(error instanceof Error ? error.message : '保存失败，请重试；输入的备注已保留。');
    } finally {
      creatingRef.current = false;
      setCreatingKind(null);
    }
  };

  const handleDelete = async (mark: ReaderMark) => {
    if (deletingRef.current.has(mark.id) || deletingIds.includes(mark.id) || relocatingRef.current.has(mark.id) || relocatingIds.includes(mark.id)) return;
    deletingRef.current.add(mark.id);
    const previous = document.activeElement;
    const remainingIds = sortedMarks.slice(sortedMarks.findIndex(item => item.id === mark.id) + 1).map(item => item.id)
      .concat(sortedMarks.slice(0, sortedMarks.findIndex(item => item.id === mark.id)).reverse().map(item => item.id));
    setLocalError('');
    setMessage('');
    const revision = identityRef.current;
    const isCurrent = () => identityRef.current === revision && getAccountScope() === scope;
    try {
      const confirmed = await onDeleteMark(mark);
      if (!isCurrent()) return;
      if (confirmed) {
        setMessage('标记已删除');
        window.requestAnimationFrame(() => {
          if (!isCurrent() || !ownsFocus(previous)) return;
          const rows = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-reader-mark-id]') ?? []);
          const next = remainingIds.map(id => rows.find(row => row.dataset.readerMarkId === id)?.querySelector<HTMLButtonElement>('[data-reader-mark-jump]:not(:disabled)')).find(Boolean);
          (next
            ?? panelRef.current?.querySelector<HTMLButtonElement>('[aria-label="刷新书签与备注"]'))?.focus({ preventScroll: true });
        });
      }
      else setLocalError('删除失败，标记已保留，可重试。');
    } catch {
      if (isCurrent()) setLocalError('删除失败，标记已保留，可重试。');
    } finally {
      deletingRef.current.delete(mark.id);
    }
  };

  const handleRelocate = async (mark: ReaderMark) => {
    if (contentUpdate || !onRelocateMark || relocatingRef.current.has(mark.id) || relocatingIds.includes(mark.id) || deletingIds.includes(mark.id)) return;
    const previous = document.activeElement;
    const action = Symbol(mark.id);
    const revision = identityRef.current;
    const isCurrent = () => identityRef.current === revision && getAccountScope() === scope;
    relocatingRef.current.set(mark.id, action);
    setLocalError('');
    setMessage('');
    try {
      const confirmed = await onRelocateMark(mark, currentMarkInput);
      if (!isCurrent()) return;
      if (confirmed) {
        setMessage('定位已更新，原标记内容已保留。');
        window.requestAnimationFrame(() => {
          if (!isCurrent() || !ownsFocus(previous)) return;
          const row = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-reader-mark-id]') ?? []).find((item) => item.dataset.readerMarkId === mark.id);
          row?.querySelector<HTMLButtonElement>('[data-reader-mark-jump]')?.focus({ preventScroll: true });
        });
      } else setLocalError('尚未重新定位，原标记内容已保留，可重试。');
    } catch (error) {
      if (isCurrent()) setLocalError(error instanceof Error ? error.message : '重新定位失败，原标记内容已保留，可重试。');
    } finally {
      if (relocatingRef.current.get(mark.id) === action) relocatingRef.current.delete(mark.id);
    }
  };

  if (!isOpen) return null;
  const saving = isSaving || creatingKind !== null;

  return (
    <div ref={viewportRef} className="reader-panel-backdrop viewport-dialog fixed inset-0 z-[90]" onClick={onClose}>
      <aside
        aria-label="书签与备注"
        aria-modal="true"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
        className={cn(
          'reader-panel-sheet absolute inset-x-0 bottom-0 flex w-full flex-col focus:outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[390px] sm:max-w-sm',
          `reader-marks-panel reader-theme-${theme}`,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="reader-panel-heading flex items-center justify-between px-5 pb-4 pt-5">
          <div>
            <p className="text-xs text-current/50">标记</p>
            <h2 className="text-base font-semibold">书签与备注 {hasLoaded && <span className="ml-2 text-xs font-normal opacity-60">{marks.length} 条</span>}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button aria-label="刷新书签与备注" title="刷新书签与备注" aria-busy={isLoading} aria-disabled={isLoading} className="reader-chrome-action grid h-11 w-11 place-items-center rounded-full aria-disabled:opacity-50" onClick={() => { if (!isLoading) onReload(); }} type="button">
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
            <button aria-label="关闭书签与备注" className="grid h-11 w-11 place-items-center rounded-full transition hover:bg-current/10" onClick={onClose} type="button">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto reader-scrollbar">
          <div className="reader-marks-compose-region px-5 pb-5">
            {contentUpdate && <div className="reader-marks-position-recovery mb-4 text-xs leading-5">
              <p className="reader-mark-meta" id="reader-mark-edition-notice" role="status">{editionSwitch ? '阅读文件已更新，请先打开新版再保存或跳转。草稿和标记内容会保留。' : '本话已更新，请先加载新版正文再保存或跳转。草稿和标记内容会保留。'}</p>
              <button data-reader-mark-load-edition aria-busy={contentUpdate.isLoading} aria-disabled={contentUpdate.isLoading} className="reader-chrome-action mt-1 inline-flex min-h-11 items-center gap-2 aria-disabled:opacity-50" onClick={() => { if (!contentUpdate.isLoading) contentUpdate.onLoad(); }} type="button">
                {contentUpdate.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {contentUpdate.isLoading ? '正在加载新版…' : contentUpdate.error ? '重试加载新版' : editionSwitch ? '打开新版阅读器' : '加载新版正文'}
              </button>
              {contentUpdate.error && <p className="reader-mark-error mt-1 break-words" role="alert">{contentUpdate.error}</p>}
            </div>}
            <div className="reader-mark-compose">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center text-accent">
                  <BookmarkPlus className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{currentMarkInput.label || '当前位置'}</p>
                  <p className="reader-mark-meta mt-1 text-xs">{formatMarkPosition(currentMarkInput)} · {formatReadingProgressPercent(currentMarkInput.progressPercent)}</p>
                </div>
              </div>
              <textarea
                aria-label="阅读备注"
                aria-describedby="reader-note-help"
                className="reader-line-textarea mt-3 min-h-20 w-full resize-y bg-transparent px-1 py-2 text-sm outline-none transition placeholder:text-current/35"
                maxLength={2000}
                onChange={(event) => {
                  const text = event.target.value;
                  setMessage('');
                  setDraft((current) => ({ text, origin: text.trim() ? current.origin ?? currentMarkInput : null }));
                }}
                placeholder="写一条备注，可留空只加书签"
                value={noteDraft}
              />
              <p className="reader-mark-meta flex justify-between gap-3 text-[11px] leading-5" id="reader-note-help"><span>{draft.origin ? `草稿位置：${formatMarkPosition(draft.origin)} · ${formatReadingProgressPercent(draft.origin.progressPercent)}` : '收起后保留草稿和位置'}</span><span className="shrink-0 tabular-nums">{noteDraft.length}/2000</span></p>
              {draft.origin && !isSameReaderNotePosition(draft.origin, currentMarkInput) && (
                <button aria-disabled={Boolean(contentUpdate)} aria-describedby={contentUpdate ? 'reader-mark-edition-notice' : undefined} className="reader-chrome-action mt-1 inline-flex min-h-11 items-center px-2 text-xs aria-disabled:opacity-45" type="button" onClick={() => {
                  if (contentUpdate) return;
                  setDraft((current) => ({ ...current, origin: { ...currentMarkInput, note: current.origin?.note } }));
                  setLocalError('');
                  setMessage('');
                }}>改存到当前位置</button>
              )}
              {selectedExcerpt && (
                <blockquote className="mt-2 line-clamp-3 border-l-2 border-accent/40 px-3 py-1 text-xs leading-5 text-current/70">
                  {selectedExcerpt}
                </blockquote>
              )}
              <div className="reader-mark-save-actions mt-3 grid grid-cols-2 gap-2">
                <button
                  className="reader-chrome-action inline-flex min-h-11 items-center justify-center gap-2 px-3 text-sm font-medium aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                  aria-disabled={saving || Boolean(contentUpdate)}
                  aria-describedby={contentUpdate ? 'reader-mark-edition-notice' : undefined}
                  onClick={() => void handleCreate('bookmark')}
                  type="button"
                >
                  {creatingKind === 'bookmark' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bookmark className="h-4 w-4" />}
                  {creatingKind === 'bookmark' ? '保存中' : '加书签'}
                </button>
                <button
                  className="reader-settings-done inline-flex min-h-11 items-center justify-center gap-2 px-3 text-sm font-medium transition aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                  aria-disabled={saving || !trimmedNote || Boolean(contentUpdate)}
                  aria-describedby={contentUpdate ? 'reader-mark-edition-notice' : undefined}
                  onClick={() => void handleCreate('note')}
                  type="button"
                >
                  {creatingKind === 'note' ? <Loader2 className="h-4 w-4 animate-spin" /> : <NotebookPen className="h-4 w-4" />}
                  {creatingKind === 'note' ? '保存中' : selectedExcerpt ? '存摘录' : '存备注'}
                </button>
              </div>
              {(error || localError) && <p className="reader-mark-error mt-3 break-words text-xs leading-5" role="alert">{error || localError}</p>}
              {message && !error && !localError && <p className="mt-3 text-xs leading-5" role="status">{message === '备注已保存' && trimmedNote ? '上一条备注已保存，当前草稿尚未保存。' : message}</p>}
            </div>
          </div>

          <div className="reader-marks-list-region px-3 py-3">
            {isLoading && <p className="reader-mark-meta flex items-center justify-center gap-2 px-3 py-5 text-sm" role="status"><Loader2 className="h-4 w-4 animate-spin" />正在加载书签与备注…</p>}
            {loadError && (
              <div className="px-3 py-4 text-sm">
                <p className="reader-mark-error break-words leading-6" role="alert">{loadError}</p>
                <button className="reader-chrome-action mt-2 inline-flex min-h-11 items-center gap-2 px-3" aria-disabled={isLoading} onClick={() => { if (!isLoading) onReload(); }} type="button"><RefreshCw className="h-4 w-4" />重试加载</button>
              </div>
            )}
            {sortedMarks.length ? (
              <div>
                {sortedMarks.map((mark) => {
                  const checkingPdfPages = resource?.readerType === 'pdf' && mark.readerType === 'pdf'
                    && mark.positionValid !== false && !resource.pageCount;
                  const unavailable = mark.positionValid === false || mark.bookId !== bookId
                    || mark.readerType !== currentMarkInput.readerType
                    || Boolean(resource && !resolveReaderMarkTarget(mark, resource));
                  return (
                  <div
                    className={cn(
                      'reader-mark-item group flex w-full items-start gap-3 px-3 py-3 text-sm transition',
                      isDark ? 'hover:bg-white/[0.055]' : 'hover:bg-black/[0.025]',
                    )}
                    key={mark.id}
                    data-reader-mark-id={mark.id}
                  >
                    <span className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center', mark.kind === 'note' ? 'text-accent' : 'text-current/55')}>
                      {mark.kind === 'note' ? <NotebookPen className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                    <button
                      className="min-h-11 w-full text-left disabled:cursor-default"
                      data-reader-mark-jump
                      disabled={unavailable || Boolean(contentUpdate)}
                      aria-describedby={contentUpdate ? 'reader-mark-edition-notice' : unavailable ? `reader-mark-location-${mark.id}` : undefined}
                      onClick={() => {
                        if (unavailable || contentUpdate) return;
                        if (onSelectMark(mark) === false) {
                          setLocalError('这条标记的定位已更新，请刷新列表；原内容已保留。');
                          return;
                        }
                        onClose();
                      }}
                      type="button"
                    >
                        <span className="block truncate font-medium">{mark.label || formatMarkPosition(mark)}</span>
                        <span className="reader-mark-meta mt-1 block text-xs">
                          {formatMarkPosition(mark)} · {formatReadingProgressPercent(mark.progressPercent)} · {formatMarkTime(mark.createdAt)}
                        </span>
                    </button>
                    {mark.note && <p className={cn('reader-mark-note mt-1 select-text whitespace-pre-wrap break-words', mark.note.length > 100 && !expandedIds.includes(mark.id) && 'line-clamp-2')}>{mark.note}</p>}
                    {mark.note.length > 100 && <button aria-expanded={expandedIds.includes(mark.id)} className="reader-mark-meta reader-chrome-action inline-flex min-h-11 items-center text-xs" onClick={() => setExpandedIds((ids) => ids.includes(mark.id) ? ids.filter((id) => id !== mark.id) : [...ids, mark.id])} type="button">{expandedIds.includes(mark.id) ? '收起备注' : '展开备注'}</button>}
                    {unavailable && <div className="reader-mark-meta mt-2 text-xs leading-5">
                      <p id={`reader-mark-location-${mark.id}`}>{checkingPdfPages ? '正在确认 PDF 页码，载入后可跳转。' : mark.readerType !== currentMarkInput.readerType ? '来自旧阅读格式，无法在当前文件中定位。标记内容仍保留。' : '旧定位已失效。标记内容仍保留。'}</p>
                      {onRelocateMark && !checkingPdfPages && <button aria-busy={relocatingIds.includes(mark.id)} aria-describedby={contentUpdate ? 'reader-mark-edition-notice' : undefined} className="reader-chrome-action mt-1 inline-flex min-h-11 items-center gap-1.5 aria-disabled:opacity-50" aria-disabled={relocatingIds.includes(mark.id) || deletingIds.includes(mark.id) || Boolean(contentUpdate)} onClick={() => void handleRelocate(mark)} type="button">
                        {relocatingIds.includes(mark.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
                        {relocatingIds.includes(mark.id) ? '定位中…' : `定位到当前${currentMarkInput.readerType === 'text' || currentMarkInput.readerType === 'epub' ? '章节' : '页'}`}
                      </button>}
                    </div>}
                    </div>
                    <button
                      aria-label={`删除标记 ${mark.label || formatMarkPosition(mark)}`}
                      aria-busy={deletingIds.includes(mark.id)}
                      aria-disabled={deletingIds.includes(mark.id) || relocatingIds.includes(mark.id)}
                      className="reader-mark-meta grid h-11 w-11 shrink-0 place-items-center rounded-xl transition hover:bg-red-500/10 hover:text-[color:var(--reader-mark-danger)] aria-disabled:opacity-50"
                      onClick={() => void handleDelete(mark)}
                      type="button"
                    >
                      {deletingIds.includes(mark.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                ); })}
              </div>
            ) : hasLoaded && !isLoading && !loadError ? (
              <p className="reader-mark-meta px-4 py-10 text-center text-sm">还没有书签或备注。</p>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}

function sortMarks(marks: ReaderMark[]): ReaderMark[] {
  return [...marks].sort((left, right) => {
    const leftPosition = left.chapterIndex ?? left.imageIndex ?? left.pageNumber ?? 0;
    const rightPosition = right.chapterIndex ?? right.imageIndex ?? right.pageNumber ?? 0;

    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition;
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
}

function formatMarkPosition(mark: Pick<ReaderMark, 'chapterIndex' | 'imageIndex' | 'pageNumber'>): string {
  if (mark.chapterIndex) {
    return `第 ${mark.chapterIndex} 章`;
  }

  if (mark.imageIndex) {
    return `第 ${mark.imageIndex} 页`;
  }

  if (mark.pageNumber) {
    return `第 ${mark.pageNumber} 页`;
  }

  return '当前位置';
}

function formatMarkTime(value: string): string {
  const date = parseAppDate(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(date);
}
