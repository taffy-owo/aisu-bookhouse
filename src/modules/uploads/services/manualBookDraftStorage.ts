import type { ManualBookDraft } from './manualBookDraft';

export type ManualBookDraftStorageIssue = 'read' | 'save' | 'clear' | null;
export interface ManualBookDraftStorageState {
  draft: ManualBookDraft | null;
  issue: ManualBookDraftStorageIssue;
}

/** Keep failed writes and deletions within this tab, separated by account. */
export function createManualBookDraftStorage(getStorage: () => Storage, getKey: () => string) {
  const pending = new Map<string, ManualBookDraft | null>();
  const failedState = (draft: ManualBookDraft | null): ManualBookDraftStorageState => ({ draft, issue: draft ? 'save' : 'clear' });
  const persist = (draft: ManualBookDraft | null): boolean => {
    const key = getKey();
    const record = draft?.content.trim() ? { ...draft } : null;
    pending.set(key, record);
    try {
      const storage = getStorage();
      if (record) storage.setItem(key, JSON.stringify(record));
      else storage.removeItem(key);
      pending.delete(key);
      return true;
    } catch { return false; }
  };
  const read = (): ManualBookDraftStorageState => {
    const key = getKey();
    // An unsaved edit or confirmed deletion is newer than the disk copy.
    if (pending.has(key)) return failedState(pending.get(key) ?? null);
    try {
      const raw = getStorage().getItem(key);
      if (!raw) return { draft: null, issue: null };
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid manual draft');
      const value = parsed as Partial<ManualBookDraft>;
      const draft: ManualBookDraft = {
        author: typeof value.author === 'string' ? value.author : '',
        content: typeof value.content === 'string' ? value.content : '',
        description: typeof value.description === 'string' ? value.description : '',
        publicationStatus: value.publicationStatus === 'ongoing' ? 'ongoing' : 'completed',
        sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : '',
        tags: typeof value.tags === 'string' ? value.tags : '',
        title: typeof value.title === 'string' ? value.title : '',
        requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        submittedAt: typeof value.submittedAt === 'string' ? value.submittedAt : undefined,
      };
      if (!draft.content.trim()) return { draft: null, issue: persist(null) ? null : 'clear' };
      return { draft, issue: null };
    } catch { return { draft: null, issue: 'read' }; }
  };
  return {
    read,
    save: (draft: ManualBookDraft) => persist(draft),
    clear: () => persist(null),
    retry(): ManualBookDraftStorageState {
      const key = getKey();
      if (!pending.has(key)) return read();
      const draft = pending.get(key) ?? null;
      return persist(draft) ? { draft, issue: null } : failedState(draft);
    },
  };
}
