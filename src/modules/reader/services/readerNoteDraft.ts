import { getAccountScope } from '../../../shared/api';
import type { ReaderMarkCreateInput } from '../types/reader';

type Draft = { text: string; origin: ReaderMarkCreateInput | null; revision: number };
const empty: Draft = { text: '', origin: null, revision: 0 };
const drafts = new Map<string, Draft>();
const listeners = new Map<string, Set<() => void>>();

export function createReaderNoteDraft(bookId: string, scope = getAccountScope()) {
  const key = `aisu:reader-note-draft:${JSON.stringify([scope, bookId])}`;
  if (!drafts.has(key)) {
    let initial = empty;
    try {
      const stored: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
      if (stored && typeof stored === 'object' && 'text' in stored && typeof stored.text === 'string' && stored.text.length <= 2000 && 'origin' in stored) {
        const origin = stored.origin;
        if (origin === null || (typeof origin === 'object' && origin && 'readerType' in origin && ['text', 'epub', 'pdf', 'comic', 'image', 'unsupported'].includes(String(origin.readerType)) && 'label' in origin && typeof origin.label === 'string' && 'progressPercent' in origin && typeof origin.progressPercent === 'number')) {
          initial = { text: stored.text, origin: origin as ReaderMarkCreateInput | null, revision: 0 };
        }
      }
    } catch { /* Keep an in-memory draft when session storage is unavailable. */ }
    drafts.set(key, initial);
  }
  const getSnapshot = () => drafts.get(key) ?? empty;
  const update = (change: (current: Draft) => Pick<Draft, 'text' | 'origin'>) => {
    if (scope !== getAccountScope()) return;
    const current = getSnapshot();
    const value = change(current);
    const next = { ...value, revision: current.revision + 1 };
    drafts.set(key, next);
    try {
      if (next.text) window.sessionStorage.setItem(key, JSON.stringify({ text: next.text, origin: next.origin }));
      else window.sessionStorage.removeItem(key);
    } catch { /* The current tab still retains the draft. */ }
    listeners.get(key)?.forEach((listener) => listener());
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, subscribers); subscribers.add(listener);
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
    },
    update,
    clearIfRevision(revision: number) {
      if (getSnapshot().revision === revision) update(() => ({ text: '', origin: null }));
    },
  };
}
