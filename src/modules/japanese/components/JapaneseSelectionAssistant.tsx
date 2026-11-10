import { Check, Copy, Languages, LoaderCircle, Sparkles, Square, Volume2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import type { ReaderTheme } from '../../reader/types/reader';
import { translateJapaneseTexts } from '../services/japaneseAiTranslationService';
import { lookupJapaneseText } from '../services/japaneseLookupService';
import { createJapaneseSelectionController, isJapaneseSentence } from '../services/japaneseSelectionController';
import { getJapaneseSelectionText } from '../services/japaneseSelectionText';
import { speakJapaneseSelection } from '../services/japaneseSelectionSpeech';

interface JapaneseSelectionAssistantProps {
  articleRef: RefObject<HTMLElement | null>;
  bookId?: string;
  chapterTitle: string;
  disabled?: boolean;
  theme: ReaderTheme;
  workTitle: string;
}

export function JapaneseSelectionAssistant({ articleRef, bookId, chapterTitle, disabled = false, theme, workTitle }: JapaneseSelectionAssistantProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const controller = useMemo(() => createJapaneseSelectionController(
    { bookId, chapterTitle, workTitle },
    {
      lookup: (currentBookId, text, signal) => lookupJapaneseText(currentBookId, text, signal),
      speak: speakJapaneseSelection,
      translate: (context, text, signal) => translateJapaneseTexts([text], { context, signal }).then((result) => result.get(text.trim()) ?? ''),
      copy: async (text) => {
        if (!navigator.clipboard) throw new Error('复制失败，请手动复制');
        await navigator.clipboard.writeText(text);
      },
    },
  ), [bookId, chapterTitle, workTitle]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const viewportRef = useDialogViewport(Boolean(state.text) && !disabled);

  useEffect(() => {
    if (disabled) {
      controller.reset();
      return;
    }
    const updateSelection = () => {
      const selection = window.getSelection();
      const panel = panelRef.current;
      // Focus and text selection inside the helper must not discard its result.
      if (panel?.contains(document.activeElement) || (selection?.anchorNode && panel?.contains(selection.anchorNode))) return;
      const body = articleRef.current?.querySelector('.reader-body-text');
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed
        || !selection.anchorNode || !selection.focusNode
        || !body?.contains(selection.anchorNode) || !body.contains(selection.focusNode)) {
        controller.select(null);
        return;
      }
      const range = selection.getRangeAt(0);
      // A generated Chinese translation is not a new Japanese lookup source.
      if ([...body.querySelectorAll('.reader-ai-translation')].some((translation) => range.intersectsNode(translation))) {
        controller.select(null);
        return;
      }
      controller.select(getJapaneseSelectionText(range));
    };
    const handleOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) controller.select(null);
    };
    document.addEventListener('selectionchange', updateSelection);
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    return () => {
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
    };
  }, [articleRef, controller, disabled]);

  useEffect(() => {
    if (!state.text || disabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      const hadFocus = panelRef.current?.contains(document.activeElement);
      controller.select(null);
      window.getSelection()?.removeAllRanges();
      if (hadFocus) articleRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [articleRef, controller, disabled, state.text]);

  useEffect(() => () => controller.reset(), [controller]);

  if (!state.text || disabled) return null;
  const isSentence = isJapaneseSentence(state.text);
  const lookupTranslation = state.lookup?.translation?.trim();
  const englishGlosses = state.lookup?.englishGlosses.map((value) => value.trim()).filter(Boolean) ?? [];
  const closeAssistant = () => {
    const hadFocus = panelRef.current?.contains(document.activeElement);
    controller.select(null);
    window.getSelection()?.removeAllRanges();
    if (hadFocus) articleRef.current?.focus({ preventScroll: true });
  };

  return createPortal(
    <div className="reader-japanese-assistant-viewport viewport-dialog" ref={viewportRef}>
    <div
      aria-label="日文选词辅助"
      className={`reader-japanese-assistant reader-theme-${theme} reader-scrollbar notranslate`}
      data-japanese-assistant
      ref={panelRef}
      role="dialog"
      translate="no"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => { if ((event.target as Element).closest('button')) event.preventDefault(); }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        <Languages aria-hidden className="mt-3 h-4 w-4 shrink-0 text-[color:var(--reader-accent)]" />
        <p className="min-w-0 flex-1 break-words py-2 text-sm leading-6" lang="ja">{state.text}</p>
        <button aria-label="关闭日文辅助" className="reader-assistant-action grid h-11 w-11 shrink-0 place-items-center rounded-md" onClick={closeAssistant} type="button"><X aria-hidden className="h-4 w-4" /></button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        {state.lookup && (
          <div className="reader-assistant-result my-2 border-t py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <strong className="text-sm font-semibold" lang="ja">{state.lookup.dictionaryForm ?? state.text}</strong>
              {state.lookup.reading && <span className="reader-muted" lang="ja">{state.lookup.reading}</span>}
            </div>
            {lookupTranslation ? <p className="mt-1.5 text-sm leading-6">{lookupTranslation}</p> : englishGlosses.length > 0 ? (
              <div className="mt-1.5">
                <p className="reader-muted text-xs leading-5">英文释义</p>
                <p className="text-sm leading-6" lang="en">{englishGlosses.join('; ')}</p>
              </div>
            ) : <p className="reader-muted mt-1 leading-5">暂未取得释义，可以重新查词。</p>}
          </div>
        )}
        {state.aiTranslation && (
          <div className="reader-assistant-result my-2 border-t py-3">
            <div className="reader-muted mb-1.5 flex items-center gap-1.5"><Sparkles aria-hidden className="h-3.5 w-3.5" />AI 译文</div>
            <p className="text-sm leading-6">{state.aiTranslation}</p>
          </div>
        )}
      </div>
      {state.error && <p className="reader-assistant-error mb-2 py-1" role="alert">{state.error}</p>}
      {state.copyError && <p className="reader-assistant-error mb-2 py-1" role="alert">{state.copyError}</p>}
      {state.speechError && <p className="reader-assistant-error mb-2 py-1" role="alert">{state.speechError}</p>}
      <div className="reader-assistant-actions grid gap-1.5 pt-1">
        <button aria-label={state.isSpeaking ? '停止朗读' : '朗读'} className="reader-assistant-action inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 py-2" onClick={controller.toggleSpeech} type="button">{state.isSpeaking ? <Square aria-hidden className="h-3.5 w-3.5" /> : <Volume2 aria-hidden className="h-3.5 w-3.5" />}{state.isSpeaking ? '停止' : '朗读'}</button>
        <button
          aria-busy={state.isLookingUp}
          className="reader-assistant-primary inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 py-2 font-medium disabled:opacity-60"
          disabled={state.isLookingUp}
          onClick={() => void controller.request()}
          type="button"
        >
          {state.isLookingUp ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : isSentence ? <Sparkles aria-hidden className="h-3.5 w-3.5" /> : <Languages aria-hidden className="h-3.5 w-3.5" />}
          {state.isLookingUp ? (isSentence ? '翻译中' : '查询中') : isSentence ? 'AI 翻译' : '查词'}
        </button>
        <button className="reader-assistant-action inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 py-2" onClick={() => void controller.copy()} type="button">
          {state.isCopied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}<span aria-live="polite">{state.isCopied ? '已复制' : '复制'}</span>
        </button>
      </div>
    </div>
    </div>, document.body,
  );
}
