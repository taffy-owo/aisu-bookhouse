import { getAccountScope } from '../../../shared/api';

export interface ChapterDraft {
  content: string;
  title: string;
  preparedBody: boolean;
  baseRevision?: string;
}

interface DraftState {
  value: ChapterDraft | null;
  version: number;
  pending: boolean;
  issue: 'read' | 'save' | 'clear' | null;
}

const stores = new Map<string, ReturnType<typeof createStore>>();

function createStore(key: string, scope: string, needsRevision: boolean) {
  let state: DraftState = { value: null, version: 0, pending: false, issue: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<DraftState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const read = () => {
    try {
      const raw = window.sessionStorage.getItem(key);
      const value: unknown = raw === null ? null : JSON.parse(raw);
      if (value !== null && (typeof value !== 'object' || Array.isArray(value)
        || !('content' in value) || typeof value.content !== 'string'
        || !('title' in value) || typeof value.title !== 'string'
        || !('preparedBody' in value) || typeof value.preparedBody !== 'boolean'
        || (needsRevision && !('baseRevision' in value))
        || ('baseRevision' in value && (typeof value.baseRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.baseRevision))))) throw Error('Invalid chapter draft');
      publish({ value: value as ChapterDraft | null, issue: null });
    } catch { publish({ issue: 'read' }); }
  };
  const flush = () => {
    clearTimeout(timer);
    if (!state.pending) return;
    try {
      if (state.value) window.sessionStorage.setItem(key, JSON.stringify(state.value));
      else window.sessionStorage.removeItem(key);
      publish({ pending: false, issue: null });
    } catch { publish({ issue: state.value ? 'save' : 'clear' }); }
  };
  read();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(value: ChapterDraft) {
      if (scope !== getAccountScope()) return;
      publish({ value: { ...value }, version: state.version + 1, pending: true });
      clearTimeout(timer);
      timer = setTimeout(flush, 350);
    },
    clearIfVersion(version: number) {
      if (state.version !== version) return;
      publish({ value: null, version: version + 1, pending: true });
      flush();
    },
    flush,
    retry() { if (state.pending) flush(); else read(); },
  };
}

/** Each tab keeps independent drafts, separated by account, book and chapter. */
export function getChapterDraft(bookId: string, target: number | 'append', scope = getAccountScope()) {
  const key = `aisu-bookhouse:chapter-draft:${JSON.stringify([scope, bookId, target])}`;
  let store = stores.get(key);
  if (!store) { store = createStore(key, scope, typeof target === 'number' && target > 0); stores.set(key, store); }
  return store;
}
