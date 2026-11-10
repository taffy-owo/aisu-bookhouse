import { getAccountScope } from '../../../shared/api';
import type { ReaderMark, ReaderMarkCreateInput, ReaderMarkPositionInput } from '../types/reader';

export interface ReaderMarksState {
  marks: ReaderMark[];
  deletingIds: string[];
  relocatingIds: string[];
  error: string | null;
  hasLoaded: boolean;
  isLoading: boolean;
  loadError: string | null;
  isSaving: boolean;
}
const EMPTY_MARKS_STATE: ReaderMarksState = { marks: [], deletingIds: [], relocatingIds: [], error: null, hasLoaded: false, isLoading: false, loadError: null, isSaving: false };
type ReaderMarksApi = {
  load: (bookId: string, signal?: AbortSignal) => Promise<ReaderMark[]>;
  create: (bookId: string, input: ReaderMarkCreateInput, signal?: AbortSignal) => Promise<ReaderMark>;
  remove: (bookId: string, markId: string, signal?: AbortSignal) => Promise<void>;
  relocate?: (bookId: string, markId: string, position: ReaderMarkPositionInput, signal?: AbortSignal) => Promise<ReaderMark>;
};

export function createReaderMarksController(
  bookId: string,
  api: ReaderMarksApi,
  readScope = getAccountScope,
  scope = readScope(),
) {
  let state: ReaderMarksState = { ...EMPTY_MARKS_STATE };
  let generation = 0;
  let mutationIntent = 0;
  let loadController: AbortController | null = null;
  let refreshRequested = false;
  // Confirmed writes made while a list is in flight must win over its snapshot.
  const loadMutations = new Map<string, ReaderMark | null>();
  let createController: AbortController | null = null;
  const removeControllers = new Map<string, AbortController>();
  const relocateControllers = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ReaderMarksState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const current = (request: number) => request === generation && scope === readScope();
  const matchesBook = (mark: ReaderMark) => mark.bookId === bookId;
  const marksController = {
    getSnapshot: () => scope === readScope() ? state : EMPTY_MARKS_STATE,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset: () => {
      generation += 1;
      mutationIntent += 1;
      loadController?.abort();
      loadController = null;
      refreshRequested = false;
      loadMutations.clear();
      createController?.abort();
      createController = null;
      removeControllers.forEach((controller) => controller.abort());
      removeControllers.clear();
      relocateControllers.forEach((controller) => controller.abort());
      relocateControllers.clear();
      state = { ...EMPTY_MARKS_STATE };
      listeners.forEach((listener) => listener());
    },
    seed: (marks: ReaderMark[]) => {
      if (scope === readScope()) publish({ marks: marks.filter(matchesBook), hasLoaded: true, loadError: null });
    },
    refresh: async (): Promise<boolean> => {
      if (scope !== readScope()) return false;
      if (state.isLoading) {
        // A visible-page return can happen during the startup list request.
        // Recheck once after that snapshot instead of dropping the refresh.
        refreshRequested = true;
        return false;
      }
      return marksController.load();
    },
    load: async (): Promise<boolean> => {
      if (state.isLoading || scope !== readScope()) return false;
      const request = generation;
      const controller = new AbortController();
      loadController = controller;
      loadMutations.clear();
      publish({ isLoading: true, loadError: null });
      try {
        const marks = await api.load(bookId, controller.signal);
        if (!current(request) || controller.signal.aborted) return false;
        const reconciled = new Map(marks.filter(matchesBook).map((mark) => [mark.id, mark]));
        loadMutations.forEach((mark, id) => {
          if (mark) reconciled.set(id, mark);
          else reconciled.delete(id);
        });
        publish({ marks: [...reconciled.values()], hasLoaded: true, loadError: null });
        return true;
      } catch (error: unknown) {
        if (current(request) && !controller.signal.aborted) publish({ loadError: error instanceof Error ? error.message : '书签加载失败' });
        return false;
      } finally {
        if (loadController === controller) {
          loadController = null;
          loadMutations.clear();
        }
        if (current(request) && !controller.signal.aborted) {
          publish({ isLoading: false });
          if (refreshRequested) {
            refreshRequested = false;
            void marksController.load();
          }
        }
      }
    },
    create: async (input: ReaderMarkCreateInput): Promise<boolean> => {
      if (state.isSaving || scope !== readScope()) return false;
      const request = generation;
      const intent = ++mutationIntent;
      createController?.abort();
      const controller = new AbortController();
      createController = controller;
      publish({ error: null, isSaving: true });
      try {
        const confirmed = await api.create(bookId, input, controller.signal);
        if (!current(request) || controller.signal.aborted || confirmed.bookId !== bookId) return false;
        if (loadController) loadMutations.set(confirmed.id, confirmed);
        publish({ marks: [...state.marks.filter((mark) => mark.id !== confirmed.id), confirmed], ...(intent === mutationIntent ? { error: null } : {}) });
        return true;
      } catch (error: unknown) {
        if (current(request) && intent === mutationIntent) publish({ error: error instanceof Error ? error.message : '书签保存失败' });
        return false;
      } finally {
        if (createController === controller) createController = null;
        if (current(request) && !controller.signal.aborted) publish({ isSaving: false });
      }
    },
    remove: async (mark: ReaderMark): Promise<boolean> => {
      if (mark.bookId !== bookId || state.deletingIds.includes(mark.id) || state.relocatingIds.includes(mark.id) || scope !== readScope()) return false;
      const request = generation;
      const intent = ++mutationIntent;
      const controller = new AbortController();
      removeControllers.set(mark.id, controller);
      publish({ deletingIds: [...state.deletingIds, mark.id], error: null });
      try {
        await api.remove(bookId, mark.id, controller.signal);
        if (!current(request) || controller.signal.aborted) return false;
        if (loadController) loadMutations.set(mark.id, null);
        publish({ marks: state.marks.filter((candidate) => candidate.id !== mark.id), ...(intent === mutationIntent ? { error: null } : {}) });
        return true;
      } catch (error: unknown) {
        if (current(request) && intent === mutationIntent) publish({ error: error instanceof Error ? error.message : '书签删除失败' });
        return false;
      } finally {
        if (removeControllers.get(mark.id) === controller) removeControllers.delete(mark.id);
        if (current(request) && !controller.signal.aborted) publish({ deletingIds: state.deletingIds.filter((id) => id !== mark.id) });
      }
    },
    relocate: async (mark: ReaderMark, position: ReaderMarkPositionInput): Promise<boolean> => {
      const relocate = api.relocate;
      if (!relocate || mark.bookId !== bookId || scope !== readScope() || state.deletingIds.includes(mark.id) || state.relocatingIds.includes(mark.id)) return false;
      const request = generation;
      const intent = ++mutationIntent;
      const controller = new AbortController();
      relocateControllers.set(mark.id, controller);
      publish({ relocatingIds: [...state.relocatingIds, mark.id], error: null });
      try {
        const confirmed = await relocate(bookId, mark.id, position, controller.signal);
        if (!current(request) || controller.signal.aborted || confirmed.bookId !== bookId || confirmed.id !== mark.id) return false;
        if (loadController) loadMutations.set(confirmed.id, confirmed);
        publish({ marks: [...state.marks.filter((item) => item.id !== mark.id), confirmed], ...(intent === mutationIntent ? { error: null } : {}) });
        return true;
      } catch (error) {
        if (current(request) && intent === mutationIntent) publish({ error: error instanceof Error ? error.message : '重新定位失败，原内容已保留。' });
        return false;
      } finally {
        if (relocateControllers.get(mark.id) === controller) relocateControllers.delete(mark.id);
        if (current(request)) publish({ relocatingIds: state.relocatingIds.filter((id) => id !== mark.id) });
      }
    },
  };
  return marksController;
}
