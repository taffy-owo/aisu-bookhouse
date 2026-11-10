import type { AppendBookChapterInput, EditableBookChapterContent } from '../../books';
import type * as books from '../../books/services/bookService';
import type * as reader from './readerService';
import type { ReaderChapter, ReaderResource } from '../types/reader';
import { getChapterMutationErrorMessage } from '../../books/services/chapterMutationRequest';

export interface ChapterEditorApi {
  getEditableBookChapter: typeof books.getEditableBookChapter;
  updateBookChapter: typeof books.updateBookChapter;
  deleteBookChapter: typeof books.deleteBookChapter;
  getReaderChapter: typeof reader.getReaderChapter;
  getReaderResource: typeof reader.getReaderResource;
  resetReaderChapterCache: typeof reader.resetReaderChapterCache;
}

interface EditorState {
  chapter: EditableBookChapterContent | null;
  error: string | null;
  message: string | null;
  isLoading: boolean;
  isSaving: boolean;
  needsRefresh: boolean;
  refreshChapterIndex: number | null;
}

const initialState: EditorState = {
  chapter: null, error: null, message: null, isLoading: false, isSaving: false, needsRefresh: false, refreshChapterIndex: null,
};

/** A book-scoped editor: late responses cannot reopen a closed reader or edit another book. */
export function createChapterEditor(bookId: string, api: ChapterEditorApi) {
  let state = initialState;
  let generation = 0;
  let loadController: AbortController | null = null;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<EditorState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const clearMessage = () => {
    clearTimeout(messageTimer);
    publish({ message: null, needsRefresh: false, refreshChapterIndex: null });
  };
  const finish = (message: string, refreshChapterIndex: number | null = null) => {
    const needsRefresh = refreshChapterIndex !== null;
    clearTimeout(messageTimer);
    publish({ chapter: null, error: null, message, needsRefresh, refreshChapterIndex });
    if (!needsRefresh) messageTimer = setTimeout(clearMessage, 2600);
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clearMessage,
    clearError: () => { if (!state.isSaving) publish({ error: null }); },
    invalidate: () => {
      generation += 1;
      loadController?.abort();
      loadController = null;
      clearTimeout(messageTimer);
      state = initialState;
      listeners.forEach((listener) => listener());
    },
    close: () => {
      if (state.isSaving) return;
      generation += 1;
      loadController?.abort();
      loadController = null;
      publish({ chapter: null, error: null, isLoading: false });
    },
    open: async (chapterIndex: number) => {
      if (state.isLoading || state.isSaving) return;
      const request = ++generation;
      const controller = new AbortController();
      loadController = controller;
      clearMessage();
      publish({ error: null, isLoading: true });
      try {
        const chapter = await api.getEditableBookChapter(bookId, chapterIndex, controller.signal);
        if (request === generation) publish({ chapter });
      } catch (error) {
        if (request === generation) finish(error instanceof Error ? error.message : '本章暂时无法直接修改');
      } finally {
        if (loadController === controller) loadController = null;
        if (request === generation) publish({ isLoading: false });
      }
    },
    save: async (input: AppendBookChapterInput, onSaved: (chapter: ReaderChapter, resource: ReaderResource) => void, revision?: string) => {
      const chapter = state.chapter;
      if (!chapter || state.isSaving) return false;
      const request = ++generation;
      let committed = false;
      publish({ error: null, isSaving: true });
      try {
        await api.updateBookChapter(bookId, chapter.index, input, undefined, revision ?? chapter.revision);
        committed = true;
        api.resetReaderChapterCache(bookId);
        if (request !== generation) return true;
        const [content, resource] = await Promise.all([
          api.getReaderChapter(bookId, chapter.index), api.getReaderResource(bookId),
        ]);
        if (request !== generation) return true;
        onSaved(content, resource);
        finish(`已写入原 ${chapter.format === 'epub' ? 'EPUB' : 'TXT'} 文件`);
      } catch (error) {
        if (request !== generation) return committed;
        if (committed) finish('章节已保存，但正文刷新失败，请重新加载阅读器。', chapter.index);
        else publish({ error: getChapterMutationErrorMessage('保存', error) });
      } finally {
        if (request === generation) publish({ isSaving: false });
      }
      return committed;
    },
    remove: async (onDeleted: (resource: ReaderResource, nextIndex: number, ratio: number) => void) => {
      const chapter = state.chapter;
      if (!chapter || state.isSaving) return false;
      const request = ++generation;
      let committed = false;
      let nextIndex = chapter.index;
      publish({ error: null, isSaving: true });
      try {
        const deleted = await api.deleteBookChapter(bookId, chapter.index, undefined, chapter.revision);
        committed = true;
        nextIndex = deleted.nextIndex ?? 1;
        api.resetReaderChapterCache(bookId);
        if (request !== generation) return true;
        const resource = await api.getReaderResource(bookId);
        if (request !== generation) return true;
        onDeleted(resource, nextIndex, nextIndex < chapter.index ? 1 : 0);
        finish(`已删除本话，剩余 ${deleted.chapterCount} 话已重新排序`);
      } catch (error) {
        if (request !== generation) return committed;
        if (committed) finish('章节已删除，但目录刷新失败，请重新加载阅读器。', nextIndex);
        else publish({ error: getChapterMutationErrorMessage('删除', error) });
      } finally {
        if (request === generation) publish({ isSaving: false });
      }
      return committed;
    },
  };
}
