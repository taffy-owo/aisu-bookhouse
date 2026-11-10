export interface TranslationSubmissionInput {
  sourceUrl: string;
  customInstructions: string;
  requestConcurrency: number;
  model: string;
  channelId: string | null;
  modelLabel: string;
}

export interface TranslationSubmission extends TranslationSubmissionInput {
  id: string;
  createdAt: number;
  status: 'pending' | 'unconfirmed';
  error: string;
}

export const INTERRUPTED_TRANSLATION_SUBMISSION = '上次提交未确认。请先查看下方翻译任务，需要时按原设置重试。';
const PREFIX = 'aisu-bookhouse:translation-submission:v1:';
// Keep only writes the browser could not persist. Route changes must not discard
// them; separate keys let another tab update one submission without replacing all.
const unsaved = new Map<string, TranslationSubmission | null>();

export function createTranslationSubmissionStorage(
  scope: string,
  getStorage: () => Storage = () => window.localStorage,
  fallback = unsaved,
) {
  const prefix = `${PREFIX}${encodeURIComponent(scope)}:`;
  let readFailed = false;
  const warning = () => {
    const entries = [...fallback].filter(([key]) => key.startsWith(prefix));
    if (entries.some(([, record]) => record === null)) return '本机记录未能清除，刷新后可能再次显示。请先查看服务器任务，避免重复提交。';
    if (readFailed || entries.length) return '浏览器未能保存或读取本地记录；当前页面仍保留原设置，刷新或关闭前请复制需要的内容。';
    return '';
  };
  return {
    matchesKey: (key: string | null) => key === null || key.startsWith(prefix),
    warning,
    retryPersistence() {
      for (const [key, record] of fallback) {
        if (!key.startsWith(prefix)) continue;
        try {
          const storage = getStorage();
          if (record) storage.setItem(key, JSON.stringify(record));
          else storage.removeItem(key);
          fallback.delete(key);
        } catch { /* Try again on a later visit; no network request is sent. */ }
      }
    },
    load() {
      const records = new Map<string, TranslationSubmission>();
      readFailed = false;
      try {
        const storage = getStorage();
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (!key?.startsWith(prefix)) continue;
          const raw = storage.getItem(key);
          try {
            const record: unknown = JSON.parse(raw ?? 'null');
            if (isTranslationSubmission(record) && key === prefix + record.id) records.set(record.id, record);
          } catch { /* One damaged record must not hide other submissions. */ }
        }
      } catch { readFailed = true; }
      for (const [key, record] of fallback) {
        if (!key.startsWith(prefix)) continue;
        if (record) records.set(record.id, record);
        else records.delete(key.slice(prefix.length));
      }
      return { records: [...records.values()], failed: readFailed };
    },
    save(record: TranslationSubmission) {
      const key = prefix + record.id;
      fallback.set(key, record);
      try {
        getStorage().setItem(key, JSON.stringify(record));
        fallback.delete(key);
      } catch { /* Retain the complete snapshot in memory and show a warning. */ }
    },
    remove(id: string) {
      const key = prefix + id;
      fallback.set(key, null);
      try {
        getStorage().removeItem(key);
        fallback.delete(key);
      } catch { /* A tombstone prevents a failed removal reappearing on this tab. */ }
    },
  };
}

function isTranslationSubmission(value: unknown): value is TranslationSubmission {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TranslationSubmission>;
  return typeof record.id === 'string' && Boolean(record.id)
    && typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    && (record.status === 'pending' || record.status === 'unconfirmed')
    && typeof record.error === 'string'
    && typeof record.sourceUrl === 'string' && Boolean(record.sourceUrl.trim())
    && typeof record.customInstructions === 'string'
    && typeof record.model === 'string' && Boolean(record.model.trim())
    && typeof record.modelLabel === 'string'
    && (record.channelId === null || typeof record.channelId === 'string')
    && Number.isInteger(record.requestConcurrency)
    && record.requestConcurrency! >= 1 && record.requestConcurrency! <= 16;
}
