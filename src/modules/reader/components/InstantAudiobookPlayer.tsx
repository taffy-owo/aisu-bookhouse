import { Check, Headphones, LoaderCircle, Pause, Play, RotateCcw, RotateCw, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudiobookViewport } from '../hooks/useAudiobookViewport';
import type { AudiobookPlayerProps } from './AudiobookPlayer';
import type { AudiobookModeHandoff, AudiobookPosition } from '../types/audiobook';
import { getInstantAudiobookPosition, getInstantAudiobookResumeIndex } from '../services/audiobookHandoff';
import {
  readInstantAudiobookPreferences,
  readInstantAudiobookProgress,
  saveInstantAudiobookPreferences,
  saveInstantAudiobookProgress,
  type InstantAudiobookPreferences,
} from '../services/audiobookPreferences';
import { getReaderChapter } from '../services/readerService';
import {
  createInstantAudiobookSegments,
  detectInstantAudiobookLanguage,
  type InstantAudiobookSegment,
} from '../services/instantAudiobook';

type InstantPlaybackState = 'idle' | 'loading' | 'paused' | 'playing' | 'error';

const PLAYBACK_RATES = [0.8, 1, 1.2, 1.5, 2] as const;
const UTTERANCE_WATCHDOG_MILLISECONDS = 75_000;

export function InstantAudiobookPlayer({
  bookId,
  bookTitle,
  chapterCount,
  chineseScript = 'original',
  isControlsVisible,
  isOpen,
  onChapterComplete,
  onClose,
  onCueChange,
  onSelectChapter,
  onSwitchToQuality,
  playRequest,
  theme,
  toc,
}: AudiobookPlayerProps) {
  const playerRef = useAudiobookViewport(isOpen, isControlsVisible);
  const [preferences, setPreferences] = useState<InstantAudiobookPreferences>(() => ({ ...readInstantAudiobookPreferences(),
    ...(playRequest.handoff ? { autoAdvance: playRequest.handoff.autoAdvance, followText: playRequest.handoff.followText, playbackRate: playRequest.handoff.playbackRate } : {}),
  }));
  const [playbackState, setPlaybackState] = useState<InstantPlaybackState>('idle');
  const [audioChapterIndex, setAudioChapterIndex] = useState(0);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [segmentCount, setSegmentCount] = useState(0);
  const [language, setLanguage] = useState<'ja-JP' | 'zh-CN'>('zh-CN');
  const [errorMessage, setErrorMessage] = useState('');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const generationRef = useRef(0);
  const segmentsRef = useRef<InstantAudiobookSegment[]>([]);
  const currentSegmentRef = useRef(0);
  const currentChapterRef = useRef(0);
  const wantsPlaybackRef = useRef(!playRequest.handoff?.paused);
  const pendingPositionRef = useRef<AudiobookPosition>(playRequest.handoff ?? {});
  const voicesRef = useRef(voices);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const chapterRequestAbortRef = useRef<AbortController | null>(null);
  const watchdogRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const preferencesRef = useRef(preferences);
  const callbacksRef = useRef({ onChapterComplete, onCueChange, onSelectChapter });
  const startChapterRef = useRef<(chapterIndex: number, requestedSegment?: number, handoff?: AudiobookModeHandoff) => Promise<void>>(async () => undefined);

  useEffect(() => {
    preferencesRef.current = preferences;
    callbacksRef.current = { onChapterComplete, onCueChange, onSelectChapter };
    saveInstantAudiobookPreferences(preferences);
  }, [onChapterComplete, onCueChange, onSelectChapter, preferences]);

  useEffect(() => {
    if (!('speechSynthesis' in window)) return undefined;
    const refreshVoices = () => { voicesRef.current = window.speechSynthesis.getVoices(); setVoices(voicesRef.current); };
    refreshVoices();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices);
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  const cancelSpeech = useCallback((notify = true) => {
    generationRef.current += 1;
    clearWatchdog();
    currentUtteranceRef.current = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (notify && currentChapterRef.current > 0) {
      callbacksRef.current.onCueChange?.({
        chapterIndex: currentChapterRef.current,
        followText: preferencesRef.current.followText,
        paragraphIndex: null,
      });
    }
  }, [clearWatchdog]);

  useEffect(() => {
    // The reader component can stay mounted while the route changes books.
    // Stop device speech immediately so an old book cannot keep speaking or
    // write its segment progress after the new book is visible.
    cancelSpeech(false);
    chapterRequestAbortRef.current?.abort();
    chapterRequestAbortRef.current = null;
    segmentsRef.current = [];
    currentSegmentRef.current = 0;
    currentChapterRef.current = 0;
    setPlaybackState('idle');
    setAudioChapterIndex(0);
    setSegmentIndex(0);
    setSegmentCount(0);
    setErrorMessage('');
  }, [bookId, cancelSpeech]);

  const getSelectedVoice = useCallback((language: 'ja-JP' | 'zh-CN') => {
    const selected = voicesRef.current.find((voice) => voice.voiceURI === preferencesRef.current.voiceUri);
    if (selected && selected.lang.toLowerCase().startsWith(language.slice(0, 2).toLowerCase())) return selected;
    const languageVoices = voicesRef.current.filter((voice) => voice.lang.toLowerCase().startsWith(language.slice(0, 2).toLowerCase()));
    return languageVoices.find((voice) => voice.default)
      ?? languageVoices.find((voice) => /xiaoxiao|nanami|tingting|meijia|sinji|kyoko/iu.test(`${voice.name} ${voice.voiceURI}`))
      ?? languageVoices[0]
      ?? null;
  }, []);

  const showPausedSegment = useCallback((index: number) => {
    const segment = segmentsRef.current[index];
    if (!segment) return;
    currentSegmentRef.current = index;
    setSegmentIndex(index);
    setPlaybackState('paused');
    saveInstantAudiobookProgress(bookId, { chapterIndex: currentChapterRef.current, segmentIndex: index });
    callbacksRef.current.onCueChange?.({ chapterIndex: currentChapterRef.current, followText: preferencesRef.current.followText, paragraphIndex: segment.paragraphIndex });
  }, [bookId]);

  const speakSegment = useCallback(function speakNextSegment(requestedIndex: number, generation: number) {
    const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    const segments = segmentsRef.current;
    if (!synth || generation !== generationRef.current || !segments.length) return;
    const nextIndex = Math.min(segments.length - 1, Math.max(0, requestedIndex));
    const segment = segments[nextIndex];
    currentSegmentRef.current = nextIndex;
    setSegmentIndex(nextIndex);
    setPlaybackState('playing');
    setErrorMessage('');
    saveInstantAudiobookProgress(bookId, { chapterIndex: currentChapterRef.current, segmentIndex: nextIndex });

    const language = detectInstantAudiobookLanguage(segments);
    const utterance = new SpeechSynthesisUtterance(segment.text);
    utterance.lang = language;
    utterance.rate = preferencesRef.current.playbackRate;
    const voice = getSelectedVoice(language);
    if (voice) utterance.voice = voice;
    currentUtteranceRef.current = utterance;

    utterance.onstart = () => {
      if (generation !== generationRef.current || currentUtteranceRef.current !== utterance) return;
      callbacksRef.current.onCueChange?.({
        chapterIndex: currentChapterRef.current,
        followText: preferencesRef.current.followText,
        paragraphIndex: segment.paragraphIndex,
      });
    };
    utterance.onend = () => {
      if (generation !== generationRef.current || currentUtteranceRef.current !== utterance) return;
      clearWatchdog();
      currentUtteranceRef.current = null;
      if (nextIndex + 1 < segments.length) {
        speakNextSegment(nextIndex + 1, generation);
        return;
      }
      callbacksRef.current.onChapterComplete?.(currentChapterRef.current, preferencesRef.current.followText);
      const nextChapter = currentChapterRef.current + 1;
      if (preferencesRef.current.autoAdvance && nextChapter <= chapterCount) {
        callbacksRef.current.onSelectChapter(nextChapter);
        void startChapterRef.current(nextChapter, 0);
      } else {
        wantsPlaybackRef.current = false;
        setPlaybackState('paused');
      }
    };
    utterance.onerror = (event) => {
      if (generation !== generationRef.current || currentUtteranceRef.current !== utterance) return;
      clearWatchdog();
      currentUtteranceRef.current = null;
      if (event.error === 'canceled' || event.error === 'interrupted') {
        wantsPlaybackRef.current = false;
        setPlaybackState('paused');
        return;
      }
      setPlaybackState('error');
      setErrorMessage(`设备语音播放失败（${event.error || '未知错误'}），可重试或切换高品质语音`);
    };

    clearWatchdog();
    try {
      synth.cancel();
      synth.speak(utterance);
    } catch {
      currentUtteranceRef.current = null;
      setPlaybackState('error');
      setErrorMessage('设备语音暂时无法播放，请重试或切换高品质语音');
      return;
    }
    if (currentUtteranceRef.current !== utterance) return;
    watchdogRef.current = window.setTimeout(() => {
      if (generation !== generationRef.current || currentUtteranceRef.current !== utterance) return;
      currentUtteranceRef.current = null;
      synth.cancel();
      setPlaybackState('error');
      setErrorMessage('设备语音长时间没有响应，请重试；仍失败可切换高品质语音');
    }, UTTERANCE_WATCHDOG_MILLISECONDS);
  }, [bookId, chapterCount, clearWatchdog, getSelectedVoice]);

  const startChapter = useCallback(async (chapterIndex: number, requestedSegment?: number, handoff?: AudiobookModeHandoff) => {
    if (chapterIndex < 1 || chapterIndex > chapterCount) return;
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      setPlaybackState('error');
      setErrorMessage('当前浏览器没有设备朗读功能，请切换高品质语音');
      return;
    }
    cancelSpeech(false);
    chapterRequestAbortRef.current?.abort();
    const requestController = new AbortController();
    chapterRequestAbortRef.current = requestController;
    const generation = generationRef.current;
    wantsPlaybackRef.current = !handoff?.paused;
    pendingPositionRef.current = handoff ?? {};
    if (handoff) {
      const next = { ...preferencesRef.current, autoAdvance: handoff.autoAdvance, followText: handoff.followText, playbackRate: handoff.playbackRate };
      preferencesRef.current = next;
      setPreferences(next);
    }
    segmentsRef.current = [];
    setSegmentCount(0);
    setPlaybackState('loading');
    setErrorMessage('');
    setAudioChapterIndex(chapterIndex);
    currentChapterRef.current = chapterIndex;
    try {
      const chapter = await getReaderChapter(bookId, chapterIndex, requestController.signal);
      if (requestController.signal.aborted || generation !== generationRef.current) return;
      const segments = createInstantAudiobookSegments(chapter.blocks, chapter.content, { simplified: chineseScript === 'simplified' });
      if (!segments.length) throw new Error('本章没有可朗读的文字');
      segmentsRef.current = segments;
      setLanguage(detectInstantAudiobookLanguage(segments));
      setSegmentCount(segments.length);
      const saved = readInstantAudiobookProgress(bookId);
      const mappedIndex = handoff ? getInstantAudiobookResumeIndex(segments, handoff) : null;
      if (handoff?.paragraphIndex !== undefined && mappedIndex === null) {
        segmentsRef.current = [];
        setSegmentCount(0);
        throw new Error('暂时无法定位到刚才的段落，请重新打开当前章节。');
      }
      const resumeIndex = Math.min(mappedIndex ?? requestedSegment ?? (saved?.chapterIndex === chapterIndex ? saved.segmentIndex : 0), segments.length - 1);
      if (wantsPlaybackRef.current) speakSegment(resumeIndex, generation);
      else showPausedSegment(resumeIndex);
    } catch (error: unknown) {
      if (requestController.signal.aborted || generation !== generationRef.current) return;
      setPlaybackState('error');
      setErrorMessage(error instanceof Error ? error.message : '本章文字加载失败');
    } finally {
      if (chapterRequestAbortRef.current === requestController) chapterRequestAbortRef.current = null;
    }
  }, [bookId, cancelSpeech, chapterCount, chineseScript, showPausedSegment, speakSegment]);

  useEffect(() => {
    startChapterRef.current = startChapter;
  }, [startChapter]);

  useEffect(() => {
    if (!isOpen || !playRequest.id) return;
    void startChapterRef.current(playRequest.chapterIndex, undefined, playRequest.handoff);
  }, [bookId, isOpen, playRequest]);

  useEffect(() => () => {
    chapterRequestAbortRef.current?.abort();
    chapterRequestAbortRef.current = null;
    cancelSpeech(false);
  }, [cancelSpeech]);

  useEffect(() => {
    const keepMobileSpeechAlive = () => {
      if (playbackState === 'playing' && 'speechSynthesis' in window && window.speechSynthesis.paused) window.speechSynthesis.resume();
    };
    const interval = window.setInterval(keepMobileSpeechAlive, 10_000);
    document.addEventListener('visibilitychange', keepMobileSpeechAlive);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', keepMobileSpeechAlive);
    };
  }, [playbackState]);

  if (!isOpen) return null;
  const chapterIndex = audioChapterIndex || playRequest.chapterIndex;
  const chapterTitle = toc.find((item) => item.index === chapterIndex)?.title ?? `第 ${chapterIndex} 章`;
  const isPlaying = playbackState === 'playing' || playbackState === 'loading';
  const languageVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language.slice(0, 2).toLowerCase()));

  const updatePreferences = (patch: Partial<InstantAudiobookPreferences>) => {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    setPreferences(next);
    // Apply follow changes to the current cue, including paused speech.
    // Waiting for the next utterance leaves the reader using the old setting.
    if (patch.followText !== undefined && currentChapterRef.current > 0) {
      const segment = playbackState === 'playing' || playbackState === 'paused'
        ? segmentsRef.current[currentSegmentRef.current] : undefined;
      callbacksRef.current.onCueChange?.({
        chapterIndex: currentChapterRef.current,
        followText: next.followText,
        paragraphIndex: segment?.paragraphIndex ?? null,
      });
    }
  };
  const seekToSegment = (nextIndex: number) => {
    cancelSpeech(false);
    const generation = generationRef.current;
    const index = Math.min(Math.max(0, nextIndex), Math.max(0, segmentCount - 1));
    if (wantsPlaybackRef.current) speakSegment(index, generation);
    else showPausedSegment(index);
  };
  const closePlayer = () => {
    wantsPlaybackRef.current = false;
    chapterRequestAbortRef.current?.abort();
    chapterRequestAbortRef.current = null;
    cancelSpeech();
    setPlaybackState('idle');
    onClose();
  };

  return (
    <section ref={playerRef} aria-label="听书播放器" data-reader-controls className={`reader-audiobook-player reader-theme-${theme} fixed left-3 right-3 z-[85] mx-auto max-w-2xl overflow-y-auto overscroll-contain rounded-lg border p-3 shadow-[0_18px_54px_rgba(25,18,22,0.22)] sm:left-6 sm:right-6 sm:p-4`}>
      <div className="reader-audiobook-heading">
        <div className="reader-audiobook-symbol grid h-9 w-9 shrink-0 place-items-center rounded-md"><Headphones className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={chapterTitle}>{chapterTitle}</p>
          <p className="mt-0.5 truncate text-xs opacity-55">{playbackState === 'loading' ? '正在读取本章文字…' : `极速语音 · ${bookTitle}`}</p>
        </div>
        <button className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-xs opacity-65 transition hover:bg-black/[0.06] hover:opacity-100 dark:hover:bg-white/[0.08]" onClick={() => onSwitchToQuality?.({
          chapterIndex: currentChapterRef.current || playRequest.chapterIndex,
          ...(segmentsRef.current.length ? getInstantAudiobookPosition(segmentsRef.current, currentSegmentRef.current) : pendingPositionRef.current),
          paused: !wantsPlaybackRef.current,
          followText: preferencesRef.current.followText,
          autoAdvance: preferencesRef.current.autoAdvance,
          playbackRate: preferencesRef.current.playbackRate,
        })} type="button"><Sparkles className="h-3.5 w-3.5" />高品质</button>
        <button aria-label="关闭听书" className="grid h-9 w-9 shrink-0 place-items-center rounded-md opacity-55 transition hover:bg-black/[0.06] hover:opacity-100 dark:hover:bg-white/[0.08]" onClick={closePlayer} type="button"><X className="h-4 w-4" /></button>
      </div>

      {errorMessage && <p role="alert" className="reader-audiobook-error mt-2 text-xs leading-relaxed opacity-80 [overflow-wrap:anywhere]">{errorMessage}</p>}

      <div className="reader-audiobook-progress mt-3 flex items-center gap-2">
        <span className="w-12 shrink-0 text-right text-[11px] tabular-nums opacity-55">{segmentCount ? `${segmentIndex + 1}/${segmentCount}` : '0/0'}</span>
        <input aria-label="听书句子进度" className="h-7 min-w-0 flex-1 touch-pan-x accent-accent disabled:opacity-35" disabled={!segmentCount} max={Math.max(0, segmentCount - 1)} min={0} onChange={(event) => seekToSegment(Number(event.target.value))} step={1} type="range" value={segmentCount ? segmentIndex : 0} />
        <span className="w-10 shrink-0 text-[11px] opacity-55">即时</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <button aria-label="上一句" className="grid h-10 w-10 place-items-center rounded-md transition hover:bg-black/[0.06] disabled:opacity-30 dark:hover:bg-white/[0.08]" disabled={!segmentCount || segmentIndex <= 0} onClick={() => seekToSegment(segmentIndex - 1)} type="button"><RotateCcw className="h-4 w-4" /></button>
          <button aria-label={isPlaying ? '暂停听书' : playbackState === 'error' ? '重试听书' : '继续听书'} className="reader-audiobook-primary grid h-11 w-11 place-items-center rounded-md shadow-sm transition" onClick={() => {
            if (isPlaying) {
              wantsPlaybackRef.current = false;
              if (currentUtteranceRef.current) cancelSpeech(false);
              setPlaybackState('paused');
            } else if (segmentsRef.current.length) {
              wantsPlaybackRef.current = true;
              const generation = generationRef.current;
              speakSegment(currentSegmentRef.current, generation);
            } else if (chapterRequestAbortRef.current) {
              wantsPlaybackRef.current = true;
              setPlaybackState('loading');
            } else {
              void startChapter(chapterIndex, undefined, { ...playRequest.handoff, ...pendingPositionRef.current, chapterIndex,
                paused: false, followText: preferencesRef.current.followText, autoAdvance: preferencesRef.current.autoAdvance, playbackRate: preferencesRef.current.playbackRate });
            }
          }} type="button">
            {playbackState === 'loading' ? <LoaderCircle className="h-5 w-5 animate-spin" /> : isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 fill-current" />}
          </button>
          <button aria-label="下一句" className="grid h-10 w-10 place-items-center rounded-md transition hover:bg-black/[0.06] disabled:opacity-30 dark:hover:bg-white/[0.08]" disabled={!segmentCount || segmentIndex >= segmentCount - 1} onClick={() => seekToSegment(segmentIndex + 1)} type="button"><RotateCw className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs opacity-70 transition hover:bg-black/[0.05] hover:opacity-100 dark:hover:bg-white/[0.07]">
            <input checked={preferences.followText} className="sr-only" onChange={(event) => updatePreferences({ followText: event.target.checked })} type="checkbox" />
            <span className="grid h-4 w-4 place-items-center rounded border">{preferences.followText && <Check className="h-3 w-3" />}</span>跟随
          </label>
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs opacity-70 transition hover:bg-black/[0.05] hover:opacity-100 dark:hover:bg-white/[0.07]">
            <input checked={preferences.autoAdvance} className="sr-only" onChange={(event) => updatePreferences({ autoAdvance: event.target.checked })} type="checkbox" />
            <span className="grid h-4 w-4 place-items-center rounded border">{preferences.autoAdvance && <Check className="h-3 w-3" />}</span>连续
          </label>
          <button className="min-h-9 rounded-md px-2.5 text-xs font-medium tabular-nums transition hover:bg-black/[0.06] dark:hover:bg-white/[0.08]" onClick={() => {
            const nextRate = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(preferences.playbackRate as typeof PLAYBACK_RATES[number]) + 1) % PLAYBACK_RATES.length];
            updatePreferences({ playbackRate: nextRate });
          }} type="button">{preferences.playbackRate.toFixed(1)}x</button>
        </div>
      </div>

      {languageVoices.length > 1 && (
        <label className="mt-2 flex items-center gap-2 text-[11px] opacity-65">
          <span className="shrink-0">声音</span>
          <select className="min-w-0 flex-1 rounded-md border border-current/10 bg-transparent px-2 py-1.5 text-xs outline-none" onChange={(event) => updatePreferences({ voiceUri: event.target.value })} value={languageVoices.some((voice) => voice.voiceURI === preferences.voiceUri) ? preferences.voiceUri : ''}>
            <option value="">系统推荐</option>
            {languageVoices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}
          </select>
        </label>
      )}
    </section>
  );
}
