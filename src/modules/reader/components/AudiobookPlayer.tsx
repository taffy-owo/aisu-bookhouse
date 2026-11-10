import { Check, Headphones, LoaderCircle, Pause, Play, RotateCcw, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderTheme, ReaderTocItem } from '../types/reader';
import { getChapterAudiobookTimeline, prepareChapterAudiobook, type AudiobookTimeline } from '../services/readerService';
import { readAudiobookMode, readInstantAudiobookPreferences, saveAudiobookMode, saveInstantAudiobookPreferences, type AudiobookMode } from '../services/audiobookPreferences';
import { getAudiobookTimelineTime, getTimelineAudiobookPosition, loadAudiobookHandoff, seekAudiobookHandoff } from '../services/audiobookHandoff';
import type { AudiobookModeHandoff, AudiobookPlayRequest, AudiobookPosition } from '../types/audiobook';
import { InstantAudiobookPlayer } from './InstantAudiobookPlayer';
import { useAudiobookViewport } from '../hooks/useAudiobookViewport';
export type { AudiobookPlayRequest } from '../types/audiobook';

type PlaybackState = 'idle' | 'loading' | 'paused' | 'playing' | 'error';
type PrefetchedAudiobook = { blob: Blob; timelineUrl: string };

export interface AudiobookCueChange {
  chapterIndex: number;
  followText: boolean;
  paragraphIndex: number | null;
}

export interface AudiobookPlayerProps {
  bookId: string;
  bookTitle: string;
  chapterCount: number;
  chineseScript?: 'original' | 'simplified';
  isControlsVisible: boolean;
  isOpen: boolean;
  onChapterComplete?: (chapterIndex: number, followText: boolean) => void;
  onClose: () => void;
  onCueChange?: (change: AudiobookCueChange) => void;
  onSelectChapter: (chapterIndex: number) => void;
  onSwitchToInstant?: (handoff: AudiobookModeHandoff) => void;
  onSwitchToQuality?: (handoff: AudiobookModeHandoff) => void;
  playRequest: AudiobookPlayRequest;
  theme: ReaderTheme;
  toc: ReaderTocItem[];
}

const PLAYBACK_RATES = [0.8, 1, 1.2, 1.5, 2] as const;
const MAX_REASONABLE_CHAPTER_SECONDS = 12 * 60 * 60;
const STREAMING_PREFETCH_SECONDS = 20;

export function AudiobookPlayer(props: AudiobookPlayerProps) {
  const [mode, setMode] = useState<AudiobookMode>(() => readAudiobookMode());
  const [override, setOverride] = useState<{ bookId: string; source: AudiobookPlayRequest; request: AudiobookPlayRequest } | null>(null);
  const request = override?.bookId === props.bookId && override.source === props.playRequest ? override.request : props.playRequest;
  const switchMode = (nextMode: AudiobookMode, handoff: AudiobookModeHandoff) => {
    setOverride({ bookId: props.bookId, source: props.playRequest, request: { chapterIndex: handoff.chapterIndex, id: request.id, handoff } });
    props.onCueChange?.({ chapterIndex: handoff.chapterIndex, followText: handoff.followText, paragraphIndex: null });
    saveAudiobookMode(nextMode);
    setMode(nextMode);
  };

  if (mode === 'instant') {
    return <InstantAudiobookPlayer {...props} playRequest={request} onSwitchToQuality={(handoff) => switchMode('quality', handoff)} />;
  }
  return <QualityAudiobookPlayer {...props} playRequest={request} onSwitchToInstant={(handoff) => switchMode('instant', handoff)} />;
}

function QualityAudiobookPlayer({ bookId, bookTitle, chapterCount, isControlsVisible, isOpen, onChapterComplete, onClose, onCueChange, onSelectChapter, onSwitchToInstant, playRequest, theme, toc }: AudiobookPlayerProps) {
  const playerRef = useAudiobookViewport(isOpen, isControlsVisible);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentChapterRef = useRef(0);
  const currentObjectUrlRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const playbackAttemptRef = useRef(0);
  const playbackRateRef = useRef(1);
  const isPrimingRef = useRef(false);
  const switchingSourceRef = useRef(false);
  const prefetchRef = useRef<{ chapterIndex: number; controller: AbortController; promise: Promise<PrefetchedAudiobook | null> } | null>(null);
  const playbackAbortRef = useRef<AbortController | null>(null);
  const timelineAbortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<AudiobookTimeline | null>(null);
  const activeParagraphRef = useRef<number | null>(null);
  const activeFollowRef = useRef(true);
  const callbacksRef = useRef({ onChapterComplete, onCueChange });
  const followTextRef = useRef(true);
  const playChapterRef = useRef<(chapterIndex: number, primePlayback?: boolean, handoff?: AudiobookModeHandoff) => Promise<void>>(async () => undefined);
  const wantsPlaybackRef = useRef(!playRequest.handoff?.paused);
  const lastPositionRef = useRef<AudiobookPosition>(playRequest.handoff ?? {});
  const navigateRef = useRef(onSelectChapter);
  const chapterCountRef = useRef(chapterCount);
  const autoAdvanceRef = useRef(true);
  const [audioChapterIndex, setAudioChapterIndex] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(() => playRequest.handoff?.autoAdvance ?? readInstantAudiobookPreferences().autoAdvance);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [followText, setFollowText] = useState(() => playRequest.handoff?.followText ?? readInstantAudiobookPreferences().followText);
  const [playbackRate, setPlaybackRate] = useState(() => playRequest.handoff?.playbackRate ?? readInstantAudiobookPreferences().playbackRate);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('idle');

  useEffect(() => {
    navigateRef.current = onSelectChapter;
    chapterCountRef.current = chapterCount;
    autoAdvanceRef.current = autoAdvance;
    callbacksRef.current = { onChapterComplete, onCueChange };
    followTextRef.current = followText;
    playbackRateRef.current = playbackRate;
  }, [autoAdvance, chapterCount, followText, onChapterComplete, onCueChange, onSelectChapter, playbackRate]);

  useEffect(() => {
    saveInstantAudiobookPreferences({ ...readInstantAudiobookPreferences(), autoAdvance, followText, playbackRate });
  }, [autoAdvance, followText, playbackRate]);

  const getChapterTitle = useCallback((chapterIndex: number) => toc.find((item) => item.index === chapterIndex)?.title ?? `第 ${chapterIndex} 章`, [toc]);

  const updateMediaMetadata = useCallback((chapterIndex: number) => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      album: '爱素书屋',
      artist: bookTitle,
      title: getChapterTitle(chapterIndex),
    });
  }, [bookTitle, getChapterTitle]);

  const releaseCurrentObjectUrl = useCallback(() => {
    if (!currentObjectUrlRef.current) return;
    URL.revokeObjectURL(currentObjectUrlRef.current);
    currentObjectUrlRef.current = null;
  }, []);

  const clearPrefetch = useCallback(() => {
    prefetchRef.current?.controller.abort();
    prefetchRef.current = null;
  }, []);

  const emitCueForTime = useCallback((currentTimeSeconds: number, force = false) => {
    const timeline = timelineRef.current;
    const cues = timeline?.cues ?? [];
    const audio = audioRef.current;
    const time = timeline ? getAudiobookTimelineTime(currentTimeSeconds, timeline, audio ? getUsableAudioDuration(audio) : 0) : currentTimeSeconds;
    const cue = cues.find((item) => time >= item.startSeconds && time < item.endSeconds)
      ?? (cues.length && time >= cues[cues.length - 1].endSeconds ? cues[cues.length - 1] : undefined);
    const paragraphIndex = cue?.paragraphIndex ?? null;
    if (paragraphIndex !== null) lastPositionRef.current = getTimelineAudiobookPosition(cues, time);
    const follow = followTextRef.current;
    if (!force && paragraphIndex === activeParagraphRef.current && follow === activeFollowRef.current) return;
    activeParagraphRef.current = paragraphIndex;
    activeFollowRef.current = follow;
    if (currentChapterRef.current > 0) {
      callbacksRef.current.onCueChange?.({ chapterIndex: currentChapterRef.current, followText: follow, paragraphIndex });
    }
  }, []);

  const clearTimelineTracking = useCallback((notify = true) => {
    timelineAbortRef.current?.abort();
    timelineAbortRef.current = null;
    timelineRef.current = null;
    activeParagraphRef.current = null;
    if (notify && currentChapterRef.current > 0) {
      callbacksRef.current.onCueChange?.({ chapterIndex: currentChapterRef.current, followText: followTextRef.current, paragraphIndex: null });
    }
  }, []);

  const startTimelineTracking = useCallback((timelineUrl: string, generation: number, chapterIndex: number) => {
    const controller = new AbortController();
    timelineAbortRef.current = controller;
    void (async () => {
      try {
        const timeline = await getChapterAudiobookTimeline(timelineUrl, controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current || chapterIndex !== currentChapterRef.current) return;
        timelineRef.current = timeline;
        emitCueForTime(audioRef.current?.currentTime ?? 0, true);
      } catch {
        // Timeline metadata is optional; audio playback can continue when it is unavailable.
      } finally {
        if (timelineAbortRef.current === controller) timelineAbortRef.current = null;
      }
    })();
  }, [emitCueForTime]);

  const playLoadedAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio?.src || isPrimingRef.current) return;
    const generation = generationRef.current;
    const source = audio.src;
    const attempt = ++playbackAttemptRef.current;
    const isCurrent = () => audioRef.current === audio && generation === generationRef.current
      && source === audio.src && attempt === playbackAttemptRef.current;
    setErrorMessage('');
    try {
      await audio.play();
      if (!isCurrent()) return;
      if (wantsPlaybackRef.current) setPlaybackState('playing');
      else { audio.pause(); setPlaybackState('paused'); }
    } catch (error: unknown) {
      if (!isCurrent()) return;
      if (!wantsPlaybackRef.current) { setPlaybackState('paused'); return; }
      // A rejected play promise does not emit a media error. Keep its source
      // and seek position so a user gesture can retry without generating audio.
      setPlaybackState('error');
      setErrorMessage(error instanceof Error && error.name === 'NotAllowedError'
        ? '浏览器暂时阻止了播放，请点播放按钮重试。'
        : error instanceof Error && error.name === 'NotSupportedError'
          ? '当前浏览器无法播放这段音频，请重试或切换极速语音。'
          : '音频暂时无法播放，请重试；仍失败可切换极速语音。');
    }
  }, []);

  const playChapter = useCallback(async (chapterIndex: number, primePlayback = false, handoff?: AudiobookModeHandoff) => {
    const audio = audioRef.current;
    if (!audio || chapterIndex < 1 || chapterIndex > chapterCountRef.current) return;
    if (chapterIndex === currentChapterRef.current && audio.src && !audio.loop && !audio.error) {
      if (audio.paused && wantsPlaybackRef.current) await playLoadedAudio();
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    switchingSourceRef.current = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    releaseCurrentObjectUrl();
    playbackAbortRef.current?.abort();
    const playbackController = new AbortController();
    playbackAbortRef.current = playbackController;
    clearTimelineTracking();
    lastPositionRef.current = handoff ?? {};
    wantsPlaybackRef.current = !handoff?.paused;
    if (handoff) {
      autoAdvanceRef.current = handoff.autoAdvance;
      followTextRef.current = handoff.followText;
      playbackRateRef.current = handoff.playbackRate;
      setAutoAdvance(handoff.autoAdvance);
      setFollowText(handoff.followText);
      setPlaybackRate(handoff.playbackRate);
    }
    const pendingPrefetch = prefetchRef.current?.chapterIndex === chapterIndex && handoff?.paragraphIndex === undefined ? prefetchRef.current : null;
    if (pendingPrefetch) prefetchRef.current = null;
    clearPrefetch();
    setAudioChapterIndex(chapterIndex);
    currentChapterRef.current = chapterIndex;
    setCurrentTime(0);
    setDuration(0);
    setErrorMessage('');
    setPlaybackState('loading');
    updateMediaMetadata(chapterIndex);

    if (primePlayback && wantsPlaybackRef.current) {
      const silentUrl = createSilentWavUrl();
      currentObjectUrlRef.current = silentUrl;
      isPrimingRef.current = true;
      audio.loop = true;
      audio.src = silentUrl;
      void audio.play().catch(() => undefined);
    }

    try {
      let sourceUrl: string;
      let resumeTime: number | undefined;
      let resumeTimelineDuration: number | undefined;
      let prefetched: PrefetchedAudiobook | null = null;
      if (pendingPrefetch) {
        const abortPrefetch = () => pendingPrefetch.controller.abort();
        playbackController.signal.addEventListener('abort', abortPrefetch, { once: true });
        try {
          prefetched = await pendingPrefetch.promise;
        } finally {
          playbackController.signal.removeEventListener('abort', abortPrefetch);
        }
        if (playbackController.signal.aborted || generation !== generationRef.current) return;
      }
      if (handoff?.paragraphIndex !== undefined) {
        const ticket = await prepareChapterAudiobook(bookId, chapterIndex, playbackController.signal);
        const prepared = await loadAudiobookHandoff(ticket, handoff, playbackController.signal);
        if (playbackController.signal.aborted || generation !== generationRef.current) return;
        sourceUrl = URL.createObjectURL(prepared.blob);
        timelineRef.current = prepared.timeline;
        resumeTime = prepared.time;
        resumeTimelineDuration = prepared.timeline.durationSeconds;
      } else if (prefetched) {
        sourceUrl = URL.createObjectURL(prefetched.blob);
        startTimelineTracking(prefetched.timelineUrl, generation, chapterIndex);
      } else {
        const ticket = await prepareChapterAudiobook(bookId, chapterIndex, playbackController.signal);
        sourceUrl = ticket.audioUrl;
        startTimelineTracking(ticket.timelineUrl, generation, chapterIndex);
      }
      if (playbackController.signal.aborted || generation !== generationRef.current) return;

      audio.pause();
      releaseCurrentObjectUrl();
      if (sourceUrl.startsWith('blob:')) currentObjectUrlRef.current = sourceUrl;
      isPrimingRef.current = false;
      audio.loop = false;
      audio.src = sourceUrl;
      audio.playbackRate = playbackRateRef.current;
      audio.load();
      if (resumeTime !== undefined) {
        await seekAudiobookHandoff(audio, resumeTime, playbackController.signal, resumeTimelineDuration);
        if (playbackController.signal.aborted || generation !== generationRef.current) return;
        setCurrentTime(audio.currentTime);
        setDuration(getUsableAudioDuration(audio));
        emitCueForTime(audio.currentTime, true);
      }
      if (playbackController.signal.aborted || generation !== generationRef.current) return;
      if (wantsPlaybackRef.current) {
        await playLoadedAudio();
      } else setPlaybackState('paused');
    } catch (error: unknown) {
      if (playbackController.signal.aborted || generation !== generationRef.current) return;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      releaseCurrentObjectUrl();
      isPrimingRef.current = false;
      audio.loop = false;
      setPlaybackState('error');
      setErrorMessage(error instanceof Error ? error.message : '听书音频加载失败');
    } finally {
      if (generation === generationRef.current) switchingSourceRef.current = false;
      if (playbackAbortRef.current === playbackController) playbackAbortRef.current = null;
    }
  }, [bookId, clearPrefetch, clearTimelineTracking, emitCueForTime, playLoadedAudio, releaseCurrentObjectUrl, startTimelineTracking, updateMediaMetadata]);

  useEffect(() => {
    playChapterRef.current = playChapter;
  }, [playChapter]);

  const resumePlayback = useCallback(() => {
    wantsPlaybackRef.current = true;
    setPlaybackState('loading');
    if (switchingSourceRef.current) return;
    const audio = audioRef.current;
    if (audio?.src && !audio.loop && !audio.error) void playLoadedAudio();
    else void playChapterRef.current(currentChapterRef.current || playRequest.chapterIndex, true, {
      ...lastPositionRef.current, chapterIndex: currentChapterRef.current || playRequest.chapterIndex, paused: false,
      followText: followTextRef.current, autoAdvance: autoAdvanceRef.current, playbackRate: playbackRateRef.current,
    });
  }, [playLoadedAudio, playRequest.chapterIndex]);

  const pausePlayback = useCallback(() => {
    wantsPlaybackRef.current = false;
    audioRef.current?.pause();
    setPlaybackState('paused');
  }, []);

  const navigateAndPlay = useCallback((chapterIndex: number) => {
    if (chapterIndex < 1 || chapterIndex > chapterCountRef.current) return;
    navigateRef.current(chapterIndex);
    void playChapterRef.current(chapterIndex);
  }, []);

  const stopPlayback = useCallback(() => {
    generationRef.current += 1;
    playbackAbortRef.current?.abort();
    playbackAbortRef.current = null;
    clearTimelineTracking();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    releaseCurrentObjectUrl();
    clearPrefetch();
    switchingSourceRef.current = false;
    currentChapterRef.current = 0;
    wantsPlaybackRef.current = false;
    lastPositionRef.current = {};
    setAudioChapterIndex(0);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackState('idle');
    setErrorMessage('');
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }, [clearPrefetch, clearTimelineTracking, releaseCurrentObjectUrl]);

  const closePlayer = () => {
    stopPlayback();
    onClose();
  };

  const prefetchNextChapter = useCallback(() => {
    const nextChapterIndex = currentChapterRef.current + 1;
    // Keep failed attempts until the boundary so timeupdate does not retry them.
    if (!autoAdvanceRef.current || nextChapterIndex > chapterCountRef.current || prefetchRef.current?.chapterIndex === nextChapterIndex) return;
    const controller = new AbortController();
    prefetchRef.current?.controller.abort();
    const promise = (async (): Promise<PrefetchedAudiobook | null> => {
      try {
        const ticket = await prepareChapterAudiobook(bookId, nextChapterIndex, controller.signal);
        controller.signal.throwIfAborted();
        const response = await fetch(ticket.audioUrl, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return null;
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        return { blob, timelineUrl: ticket.timelineUrl };
      } catch {
        // Prefetch is optional; normal playback retries at the chapter boundary.
        return null;
      }
    })();
    prefetchRef.current = { chapterIndex: nextChapterIndex, controller, promise };
  }, [bookId]);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audioRef.current = audio;

    const handlePlaying = () => {
      if (!isPrimingRef.current && !switchingSourceRef.current) {
        if (!wantsPlaybackRef.current) { audio.pause(); return; }
        setErrorMessage('');
        setPlaybackState('playing');
        emitCueForTime(audio.currentTime, true);
      }
    };
    const handlePause = () => {
      if (!isPrimingRef.current && !switchingSourceRef.current && audio.src && !audio.ended && generationRef.current > 0) { wantsPlaybackRef.current = false; setPlaybackState('paused'); }
    };
    const handleWaiting = () => {
      if (switchingSourceRef.current) return;
      setPlaybackState((current) => current === 'playing' ? 'loading' : current);
    };
    const handleTimeUpdate = () => {
      if (switchingSourceRef.current) return;
      setCurrentTime(audio.currentTime || 0);
      const usableDuration = getUsableAudioDuration(audio);
      setDuration(usableDuration);
      emitCueForTime(audio.currentTime || 0);
      if ((usableDuration > 0 && audio.currentTime / usableDuration >= 0.55) || (usableDuration === 0 && audio.currentTime >= STREAMING_PREFETCH_SECONDS)) void prefetchNextChapter();
      updateMediaPosition(audio);
    };
    const handleEnded = () => {
      if (switchingSourceRef.current) return;
      callbacksRef.current.onChapterComplete?.(currentChapterRef.current, followTextRef.current);
      const nextChapter = currentChapterRef.current + 1;
      if (autoAdvanceRef.current && nextChapter <= chapterCountRef.current) navigateAndPlay(nextChapter);
      else { wantsPlaybackRef.current = false; setPlaybackState('paused'); }
    };
    const handleError = () => {
      if (switchingSourceRef.current || generationRef.current <= 0) return;
      setPlaybackState('error');
      setErrorMessage('音频播放失败，请重试');
    };

    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);
    return () => {
      generationRef.current += 1;
      switchingSourceRef.current = false;
      playbackAbortRef.current?.abort();
      playbackAbortRef.current = null;
      clearTimelineTracking(false);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
      clearPrefetch();
      releaseCurrentObjectUrl();
    };
  }, [clearPrefetch, clearTimelineTracking, emitCueForTime, navigateAndPlay, prefetchNextChapter, releaseCurrentObjectUrl]);

  useEffect(() => {
    if (!isOpen || !playRequest.id) return;
    void playChapterRef.current(playRequest.chapterIndex, true, playRequest.handoff);
  }, [bookId, isOpen, playRequest]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const audio = () => audioRef.current;
    setMediaAction('play', resumePlayback);
    setMediaAction('pause', pausePlayback);
    setMediaAction('seekbackward', (details) => seekAudio(audio(), -(details.seekOffset ?? 15)));
    setMediaAction('seekforward', (details) => seekAudio(audio(), details.seekOffset ?? 15));
    setMediaAction('seekto', (details) => {
      if (typeof details.seekTime === 'number' && audio()) audio()!.currentTime = details.seekTime;
    });
    setMediaAction('previoustrack', () => navigateAndPlay(currentChapterRef.current - 1));
    setMediaAction('nexttrack', () => navigateAndPlay(currentChapterRef.current + 1));
    return () => {
      for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'] as MediaSessionAction[]) setMediaAction(action, null);
    };
  }, [navigateAndPlay, pausePlayback, resumePlayback]);

  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playbackState === 'playing' ? 'playing' : playbackState === 'paused' || playbackState === 'error' ? 'paused' : 'none';
  }, [playbackState]);

  if (!isOpen) return null;
  const chapterTitle = audioChapterIndex ? getChapterTitle(audioChapterIndex) : getChapterTitle(playRequest.chapterIndex);
  const isPlaying = playbackState === 'playing' || playbackState === 'loading';
  const switchToInstant = () => {
    const audio = audioRef.current;
    const timeline = timelineRef.current;
    const position = !switchingSourceRef.current && audio?.src && timeline
      ? getTimelineAudiobookPosition(timeline.cues, getAudiobookTimelineTime(audio.currentTime, timeline, getUsableAudioDuration(audio)))
      : lastPositionRef.current;
    onSwitchToInstant?.({
      chapterIndex: currentChapterRef.current || playRequest.chapterIndex,
      ...position,
      paused: !wantsPlaybackRef.current,
      followText: followTextRef.current,
      autoAdvance: autoAdvanceRef.current,
      playbackRate: playbackRateRef.current,
    });
  };

  return (
    <section ref={playerRef} aria-label="听书播放器" data-reader-controls className={`reader-audiobook-player reader-theme-${theme} fixed left-3 right-3 z-[85] mx-auto max-w-2xl overflow-y-auto overscroll-contain rounded-lg border p-3 shadow-[0_18px_54px_rgba(25,18,22,0.22)] sm:left-6 sm:right-6 sm:p-4`}>
      <div className="reader-audiobook-heading">
        <div className="reader-audiobook-symbol grid h-9 w-9 shrink-0 place-items-center rounded-md"><Headphones className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={chapterTitle}>{chapterTitle}</p>
          <p className="mt-0.5 truncate text-xs opacity-55">{playbackState === 'loading' ? '正在准备高质量语音…' : bookTitle}</p>
        </div>
        {onSwitchToInstant && <button className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-xs opacity-65 transition hover:bg-black/[0.06] hover:opacity-100 dark:hover:bg-white/[0.08]" onClick={switchToInstant} type="button"><Headphones className="h-3.5 w-3.5" />极速</button>}
        <button aria-label="关闭听书" className="grid h-9 w-9 shrink-0 place-items-center rounded-md opacity-55 transition hover:bg-black/[0.06] hover:opacity-100 dark:hover:bg-white/[0.08]" onClick={closePlayer} type="button"><X className="h-4 w-4" /></button>
      </div>

      {errorMessage && <p role="alert" className="reader-audiobook-error mt-2 text-xs leading-relaxed opacity-80 [overflow-wrap:anywhere]">{errorMessage}</p>}

      <div className="reader-audiobook-progress mt-3 flex items-center gap-2">
        <span className="w-10 shrink-0 text-right text-[11px] tabular-nums opacity-55">{formatAudioTime(currentTime)}</span>
        <input aria-label="听书进度" className="h-5 min-w-0 flex-1 accent-accent disabled:opacity-35" disabled={duration <= 0} max={Math.max(duration, 1)} min={0} onChange={(event) => { const audio = audioRef.current; if (audio) audio.currentTime = Number(event.target.value); }} step={0.1} type="range" value={duration > 0 ? Math.min(currentTime, duration) : 0} />
        <span className="w-10 shrink-0 text-[11px] tabular-nums opacity-55">{duration > 0 ? formatAudioTime(duration) : '实时'}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <button aria-label="后退15秒" className="grid h-10 w-10 place-items-center rounded-md transition hover:bg-black/[0.06] dark:hover:bg-white/[0.08]" onClick={() => seekAudio(audioRef.current, -15)} type="button"><RotateCcw className="h-4 w-4" /></button>
          <button aria-label={isPlaying ? '暂停听书' : playbackState === 'error' ? '重试听书' : '继续听书'} className="reader-audiobook-primary grid h-11 w-11 place-items-center rounded-md shadow-sm transition" onClick={() => {
            if (isPlaying) pausePlayback();
            else resumePlayback();
          }} type="button">
            {playbackState === 'loading' ? <LoaderCircle className="h-5 w-5 animate-spin" /> : isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 fill-current" />}
          </button>
          <button aria-label="前进15秒" className="grid h-10 w-10 place-items-center rounded-md transition hover:bg-black/[0.06] dark:hover:bg-white/[0.08]" onClick={() => seekAudio(audioRef.current, 15)} type="button"><RotateCw className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs opacity-70 transition hover:bg-black/[0.05] hover:opacity-100 dark:hover:bg-white/[0.07]">
            <input checked={followText} className="sr-only" onChange={(event) => { const nextValue = event.target.checked; setFollowText(nextValue); followTextRef.current = nextValue; emitCueForTime(audioRef.current?.currentTime ?? 0, true); }} type="checkbox" />
            <span className="grid h-4 w-4 place-items-center rounded border">{followText && <Check className="h-3 w-3" />}</span>
            跟随
          </label>
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs opacity-70 transition hover:bg-black/[0.05] hover:opacity-100 dark:hover:bg-white/[0.07]">
            <input checked={autoAdvance} className="sr-only" onChange={(event) => { autoAdvanceRef.current = event.target.checked; setAutoAdvance(event.target.checked); if (!event.target.checked) clearPrefetch(); }} type="checkbox" />
            <span className="grid h-4 w-4 place-items-center rounded border">{autoAdvance && <Check className="h-3 w-3" />}</span>
            连续
          </label>
          <button className="min-h-9 rounded-md px-2.5 text-xs font-medium tabular-nums transition hover:bg-black/[0.06] dark:hover:bg-white/[0.08]" onClick={() => { const nextRate = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(playbackRate as typeof PLAYBACK_RATES[number]) + 1) % PLAYBACK_RATES.length]; setPlaybackRate(nextRate); playbackRateRef.current = nextRate; if (audioRef.current) audioRef.current.playbackRate = nextRate; }} type="button">{playbackRate.toFixed(1)}x</button>
        </div>
      </div>
    </section>
  );
}

function seekAudio(audio: HTMLAudioElement | null, delta: number) {
  if (!audio) return;
  const usableDuration = getUsableAudioDuration(audio);
  const seekableEnd = audio.seekable.length > 0 ? audio.seekable.end(audio.seekable.length - 1) : audio.currentTime;
  const upperBound = usableDuration > 0 ? usableDuration : Math.max(audio.currentTime, seekableEnd);
  audio.currentTime = Math.min(upperBound, Math.max(0, audio.currentTime + delta));
}

function formatAudioTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0:00';
  const totalSeconds = Math.floor(value);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function updateMediaPosition(audio: HTMLAudioElement) {
  const duration = getUsableAudioDuration(audio);
  if (!('mediaSession' in navigator) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, duration) });
  } catch {
    // Some mobile browsers expose Media Session without position support.
  }
}

function getUsableAudioDuration(audio: HTMLAudioElement): number {
  return Number.isFinite(audio.duration) && audio.duration > 0 && audio.duration <= MAX_REASONABLE_CHAPTER_SECONDS ? audio.duration : 0;
}

function setMediaAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Ignore actions unsupported by the current lock-screen player.
  }
}

function createSilentWavUrl(): string {
  const sampleRate = 8000;
  const samples = 800;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeAscii(view, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}
