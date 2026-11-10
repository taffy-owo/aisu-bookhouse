import { getAccountScope } from '../../../shared/api';
import type { JapaneseLookupResult } from './japaneseLookupService';

export interface JapaneseSelectionContext {
  bookId?: string;
  chapterTitle: string;
  workTitle: string;
}
interface SelectionDependencies {
  lookup: (bookId: string | undefined, text: string, signal: AbortSignal) => Promise<JapaneseLookupResult>;
  translate: (context: JapaneseSelectionContext, text: string, signal: AbortSignal) => Promise<string>;
  copy: (text: string) => Promise<void>;
  speak?: (text: string, onEnd: () => void, onError: (message: string) => void) => () => void;
}
interface SelectionState {
  text: string | null;
  lookup: JapaneseLookupResult | null;
  aiTranslation: string;
  error: string;
  copyError: string;
  isLookingUp: boolean;
  isCopied: boolean;
  isSpeaking: boolean;
  speechError: string;
}

export function isJapaneseSentence(text: string): boolean {
  return text.length > 12 || /[。！？!?]/u.test(text);
}

export function createJapaneseSelectionController(
  context: JapaneseSelectionContext,
  dependencies: SelectionDependencies,
  readScope = getAccountScope,
  owner = readScope(),
) {
  const empty: SelectionState = { text: null, lookup: null, aiTranslation: '', error: '', copyError: '', isLookingUp: false, isCopied: false, isSpeaking: false, speechError: '' };
  let state = empty;
  let generation = 0;
  let copyRevision = 0;
  let speechRevision = 0;
  let cancelSpeech: (() => void) | null = null;
  let pending: AbortController | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: SelectionState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const patch = (next: Partial<SelectionState>) => publish({ ...state, ...next });
  const current = (request: number) => request === generation && owner === readScope();
  const stopSpeech = () => {
    speechRevision += 1;
    const stop = cancelSpeech;
    cancelSpeech = null;
    stop?.();
  };
  const cancel = () => {
    generation += 1;
    copyRevision += 1;
    stopSpeech();
    pending?.abort();
    pending = null;
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = null;
  };
  const reset = () => {
    cancel();
    publish(empty);
  };

  return {
    getSnapshot: () => owner === readScope() ? state : empty,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset,
    toggleSpeech: () => {
      if (state.isSpeaking) {
        stopSpeech();
        patch({ isSpeaking: false });
        return;
      }
      if (!state.text || owner !== readScope()) return;
      const request = generation;
      const revision = ++speechRevision;
      const finish = (speechError = '') => {
        if (!current(request) || revision !== speechRevision) return;
        cancelSpeech = null;
        patch({ isSpeaking: false, speechError });
      };
      patch({ isSpeaking: true, speechError: '' });
      try {
        if (!dependencies.speak) throw new Error('当前浏览器不支持设备朗读');
        const stop = dependencies.speak(state.text, () => finish(), finish);
        if (current(request) && revision === speechRevision && state.isSpeaking) cancelSpeech = stop;
        else stop();
      } catch (error: unknown) {
        finish(error instanceof Error ? error.message : '设备朗读失败，请重试');
      }
    },
    select: (value: string | null) => {
      const trimmed = value?.trim() ?? '';
      const text = trimmed && trimmed.length <= 160 && owner === readScope() ? trimmed : null;
      if (text === state.text && owner === readScope()) return;
      cancel();
      publish({ ...empty, text });
    },
    request: async (): Promise<boolean> => {
      const text = state.text;
      if (!text || state.isLookingUp || owner !== readScope()) return false;
      const request = generation;
      const controller = new AbortController();
      pending = controller;
      patch({ error: '', isLookingUp: true });
      try {
        if (isJapaneseSentence(text)) {
          const translation = await dependencies.translate(context, text, controller.signal);
          if (!current(request) || controller.signal.aborted) return false;
          if (!translation.trim()) throw new Error('AI 没有返回译文，请重试');
          patch({ aiTranslation: translation });
        } else {
          const lookup = await dependencies.lookup(context.bookId, text, controller.signal);
          if (!current(request) || controller.signal.aborted) return false;
          if (lookup.query.trim() !== text) throw new Error('查词结果与所选文字不一致，请重试');
          patch({ lookup });
        }
        return true;
      } catch (error: unknown) {
        if (current(request) && !controller.signal.aborted) patch({ error: error instanceof Error ? error.message : '查询失败' });
        return false;
      } finally {
        if (current(request)) {
          if (pending === controller) pending = null;
          patch({ isLookingUp: false });
        }
      }
    },
    copy: async (): Promise<boolean> => {
      const text = state.text;
      if (!text || owner !== readScope()) return false;
      const request = generation;
      const revision = ++copyRevision;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = null;
      patch({ isCopied: false, copyError: '' });
      try {
        await dependencies.copy(text);
        if (!current(request) || revision !== copyRevision) return false;
        patch({ isCopied: true });
        copyTimer = setTimeout(() => {
          copyTimer = null;
          if (current(request) && revision === copyRevision) patch({ isCopied: false });
        }, 1200);
        return true;
      } catch (error: unknown) {
        if (current(request) && revision === copyRevision) patch({ copyError: error instanceof Error ? error.message : '复制失败，请手动复制' });
        return false;
      }
    },
  };
}
