import type { useChapterDraft } from '../hooks/useChapterDraft';

export function ChapterDraftStatus({ draft, disabled, stale = false, onDiscard, onRetrySuccess }: { draft: ReturnType<typeof useChapterDraft>; disabled: boolean; stale?: boolean; onDiscard: () => void; onRetrySuccess: () => void }) {
  if (!draft.value && !draft.issue) return null;
  return <div aria-live={draft.issue || stale ? 'polite' : 'off'} className="chapter-editor-meta mt-3 flex shrink-0 flex-wrap items-center gap-x-2 text-xs leading-relaxed text-stone-500 dark:text-night-soft" role="status">
    <span className="min-w-[150px] flex-1">{draft.issue
      ? draft.issue === 'clear' ? '旧草稿未能清除，刷新后可能再次出现。' : draft.issue === 'read' ? '暂时无法读取之前的草稿，请重试读取。' : '草稿暂未保存到浏览器，刷新或关闭前请先复制正文。'
      : stale ? '已恢复旧版本草稿。保存时会核对原操作；章节已有改动时不会覆盖。' : draft.pending ? '正在保存本页草稿…' : '草稿已暂存，刷新可恢复'}</span>
    {draft.issue && <button className="inline-flex min-h-11 items-center underline underline-offset-4 disabled:opacity-50" disabled={disabled} onClick={() => { draft.store.retry(); if (!draft.store.getSnapshot().issue) onRetrySuccess(); }} type="button">{draft.issue === 'clear' ? '重试清理' : draft.issue === 'read' && !draft.value ? '重试读取' : '重试保存'}</button>}
    {draft.value && <button className="inline-flex min-h-11 items-center underline underline-offset-4 disabled:opacity-50" disabled={disabled} onClick={() => { if (window.confirm(stale ? '丢弃未保存的草稿并载入服务器上的当前正文？' : '丢弃未保存的草稿？')) { draft.store.clearIfVersion(draft.version); onDiscard(); } }} type="button">{stale ? '丢弃草稿，载入当前版本' : '丢弃草稿'}</button>}
  </div>;
}
