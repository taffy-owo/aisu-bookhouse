import type { AudiobookPosition } from '../types/audiobook';
import type { InstantAudiobookSegment } from './instantAudiobook';
import { getChapterAudiobookTimeline, type AudiobookTimeline, type AudiobookTimelineCue, type ChapterAudiobookTicket } from './readerService';

const fraction = (value = 0) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function getInstantAudiobookPosition(segments: InstantAudiobookSegment[], index: number): AudiobookPosition {
  const segment = segments[index];
  if (!segment) return {};
  const paragraph = segments.filter(item => item.paragraphIndex === segment.paragraphIndex);
  const before = segments.slice(0, index).filter(item => item.paragraphIndex === segment.paragraphIndex);
  return {
    paragraphIndex: segment.paragraphIndex,
    paragraphOffset: before.reduce((size, item) => size + item.text.length, 0) / Math.max(1, paragraph.reduce((size, item) => size + item.text.length, 0)),
  };
}

export function getInstantAudiobookResumeIndex(segments: InstantAudiobookSegment[], position: AudiobookPosition): number | null {
  if (position.paragraphIndex === undefined) return null;
  const indexes = segments.flatMap((segment, index) => segment.paragraphIndex === position.paragraphIndex ? [index] : []);
  if (!indexes.length) return null;
  const target = fraction(position.paragraphOffset) * indexes.reduce((size, index) => size + segments[index].text.length, 0);
  let cursor = 0;
  for (const index of indexes) {
    cursor += segments[index].text.length;
    if (target < cursor) return index;
  }
  return indexes[indexes.length - 1];
}

export function getTimelineAudiobookPosition(cues: AudiobookTimelineCue[], time: number): AudiobookPosition {
  if (!Number.isFinite(time)) return {};
  const cue = cues.find(item => time < item.endSeconds) ?? cues[cues.length - 1];
  if (!cue) return {};
  return { paragraphIndex: cue.paragraphIndex, paragraphOffset: fraction((time - cue.startSeconds) / (cue.endSeconds - cue.startSeconds)) };
}

/** Convert playback seconds to estimated timeline seconds once duration is known. */
export function getAudiobookTimelineTime(time: number, timeline: AudiobookTimeline, audioDuration: number): number {
  return !timeline.ready && timeline.durationSeconds > 0 && Number.isFinite(audioDuration) && audioDuration > 0
    ? time * timeline.durationSeconds / audioDuration
    : time;
}

export function getTimelineAudiobookResumeTime(cues: AudiobookTimelineCue[], position: AudiobookPosition): number | null {
  const cue = cues.find(item => item.paragraphIndex === position.paragraphIndex);
  if (!cue) return null;
  return cue.startSeconds + fraction(position.paragraphOffset) * (cue.endSeconds - cue.startSeconds);
}

/** Finish the stream before seeking so the browser has a complete temporary source. */
export async function loadAudiobookHandoff(ticket: ChapterAudiobookTicket, position: AudiobookPosition, signal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new DOMException('定位超时', 'TimeoutError')), 120_000);
  try {
    const response = await fetch(ticket.audioUrl, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('语音加载失败，可重试或切回极速语音继续。');
    const blob = await response.blob();
    controller.signal.throwIfAborted();
    const timeline = await getChapterAudiobookTimeline(ticket.timelineUrl, controller.signal);
    controller.signal.throwIfAborted();
    // Temporary streams expose an estimated timeline because exact boundaries
    // are only known while the provider is generating the audio. It is still
    // better to resume near the saved paragraph than to reject a mode switch.
    const time = getTimelineAudiobookResumeTime(timeline.cues, position);
    if (time === null) throw new Error('暂时无法定位到刚才的段落，可重试或切回极速语音继续。');
    return { blob, timeline, time };
  } catch (error) {
    if (!signal.aborted && controller.signal.aborted) throw new Error('语音准备时间较长，可重试或切回极速语音继续。', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

/** Seek before unmuting playback so a mode switch never speaks the chapter opening first. */
export async function seekAudiobookHandoff(audio: HTMLAudioElement, time: number, signal: AbortSignal, timelineDuration?: number): Promise<void> {
  const waitFor = (eventName: string, ready: () => boolean, begin?: () => void) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      audio.removeEventListener(eventName, success);
      audio.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const success = () => finish();
    const fail = () => finish(new Error('语音定位失败，可重试或切回极速语音继续。'));
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(fail, 15_000);
    audio.addEventListener(eventName, success);
    audio.addEventListener('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    try { begin?.(); if (ready()) success(); } catch (error) { finish(error); }
  });
  await waitFor('loadedmetadata', () => audio.readyState >= 1);
  signal.throwIfAborted();
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const scaledTime = duration > 0 && Number.isFinite(timelineDuration) && timelineDuration! > 0
    ? time * duration / timelineDuration!
    : time;
  const target = duration > 0 ? Math.min(scaledTime, Math.max(0, duration - 0.001)) : scaledTime;
  await waitFor('seeked', () => !audio.seeking && Math.abs(audio.currentTime - target) < 0.01, () => { audio.currentTime = target; });
}
