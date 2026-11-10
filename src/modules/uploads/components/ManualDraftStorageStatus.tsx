import type { ManualBookDraftStorageIssue } from '../services/manualBookDraft';

export function ManualDraftStorageStatus({ disabled, hasConfirmedUpload, hasNewContent, issue, onOpenDraft, onRetry }: {
  disabled: boolean;
  hasConfirmedUpload: boolean;
  hasNewContent: boolean;
  issue: ManualBookDraftStorageIssue;
  onOpenDraft?: () => void;
  onRetry: () => void;
}) {
  if (!issue) return null;
  const actionClass = 'ml-1 inline-flex min-h-11 items-center font-medium underline decoration-current/40 underline-offset-4 disabled:opacity-50';
  return <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200/80" role="status">
    {issue === 'save'
      ? '本机草稿保存失败，浏览器存储可能不可用或已满。当前页面仍保留内容，刷新或关闭前请先复制正文。'
      : issue === 'read'
        ? '暂时无法读取本机草稿。如之前有未提交的内容，请先重试读取。'
        : `${hasConfirmedUpload ? '原文件已保存，无需再次提交。' : ''}本机旧草稿未能清除，刷新后可能重新出现。`}
    <button className={actionClass} disabled={disabled} onClick={onRetry} type="button">
      {hasNewContent ? '重试本机保存' : issue === 'read' ? '重试读取' : issue === 'clear' ? '重试清理' : '重试本机保存'}
    </button>
    {onOpenDraft && <button className={actionClass} onClick={onOpenDraft} type="button">查看手动草稿</button>}
  </p>;
}
