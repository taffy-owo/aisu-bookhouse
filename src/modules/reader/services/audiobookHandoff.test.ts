import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChapterAudiobookTimeline } from './readerService';
import { getAudiobookTimelineTime, getInstantAudiobookPosition, getInstantAudiobookResumeIndex, getTimelineAudiobookPosition, getTimelineAudiobookResumeTime, loadAudiobookHandoff, seekAudiobookHandoff } from './audiobookHandoff';

vi.mock('./readerService', () => ({ getChapterAudiobookTimeline: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

const segments = [{ paragraphIndex: 0, text: '标题' }, { paragraphIndex: 1, text: '第一句。' }, { paragraphIndex: 1, text: '第二句。' }, { paragraphIndex: 2, text: '最后。' }];
const cues = [{ paragraphIndex: 0, startSeconds: 0, endSeconds: 2 }, { paragraphIndex: 1, startSeconds: 2, endSeconds: 12 }, { paragraphIndex: 2, startSeconds: 13, endSeconds: 16 }];
const ticket = { chapterIndex: 2, audioUrl: '/audio', timelineUrl: '/timeline', cached: false };

describe('voice-mode position handoff', () => {
  it('keeps a resumed position when converting actual playback back to an estimated timeline', () => {
    const timeline = { cues, ready: false, durationSeconds: 16 };
    const resumedTime = getTimelineAudiobookResumeTime(cues, { paragraphIndex: 1, paragraphOffset: 0.5 })! * 32 / 16;
    const timelineTime = getAudiobookTimelineTime(resumedTime, timeline, 32);
    expect(getTimelineAudiobookPosition(cues, timelineTime)).toEqual({ paragraphIndex: 1, paragraphOffset: 0.5 });
    expect(getInstantAudiobookResumeIndex(segments, getTimelineAudiobookPosition(cues, timelineTime))).toBe(2);
  });
  it('keeps exact timings and uses estimated seconds while the stream duration is unknown', () => {
    expect(getAudiobookTimelineTime(7, { cues, ready: true, durationSeconds: 16 }, 32)).toBe(7);
    expect(getAudiobookTimelineTime(7, { cues, ready: false, durationSeconds: 16 }, Number.POSITIVE_INFINITY)).toBe(7);
    expect(getAudiobookTimelineTime(7, { cues, ready: false, durationSeconds: 16 }, 0)).toBe(7);
  });
  it('transfers a later sentence through the timeline without returning to the paragraph opening', () => {
    const position = getInstantAudiobookPosition(segments, 2);
    expect(position).toEqual({ paragraphIndex: 1, paragraphOffset: 0.5 });
    const time = getTimelineAudiobookResumeTime(cues, position)!;
    expect(time).toBe(7);
    expect(getInstantAudiobookResumeIndex(segments, getTimelineAudiobookPosition(cues, time))).toBe(2);
  });
  it('resumes at the sentence containing the current audio position', () => {
    expect(getInstantAudiobookResumeIndex(segments, getTimelineAudiobookPosition(cues, 5))).toBe(1);
    expect(getInstantAudiobookResumeIndex(segments, getTimelineAudiobookPosition(cues, 11))).toBe(2);
  });
  it('handles paragraph boundaries, pauses, and the finished chapter', () => {
    expect(getTimelineAudiobookPosition(cues, 12.5)).toEqual({ paragraphIndex: 2, paragraphOffset: 0 });
    expect(getTimelineAudiobookPosition(cues, 20)).toEqual({ paragraphIndex: 2, paragraphOffset: 1 });
    expect(getInstantAudiobookResumeIndex(segments, { paragraphIndex: 1, paragraphOffset: 1 })).toBe(2);
  });
  it('rejects missing paragraphs rather than silently restarting the chapter', () => {
    expect(getInstantAudiobookResumeIndex(segments, { paragraphIndex: 99 })).toBeNull();
    expect(getTimelineAudiobookResumeTime(cues, { paragraphIndex: 99 })).toBeNull();
    expect(getInstantAudiobookPosition([], 0)).toEqual({});
    expect(getTimelineAudiobookPosition([], 0)).toEqual({});
  });
  it('does not allow invalid offsets to escape the current paragraph', () => {
    expect(getTimelineAudiobookResumeTime(cues, { paragraphIndex: 1, paragraphOffset: -4 })).toBe(2);
    expect(getTimelineAudiobookResumeTime(cues, { paragraphIndex: 1, paragraphOffset: 8 })).toBe(12);
    expect(getTimelineAudiobookPosition(cues, Number.NaN)).toEqual({});
  });
});

describe('preparing seekable high-quality speech', () => {
  it('finishes the audio stream before using its final paragraph positions', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    vi.mocked(getChapterAudiobookTimeline).mockResolvedValue({ cues, ready: true, durationSeconds: 16 });
    const request = loadAudiobookHandoff(ticket, { paragraphIndex: 1, paragraphOffset: 0.5 }, new AbortController().signal);
    expect(getChapterAudiobookTimeline).not.toHaveBeenCalled();
    finish(new Response('speech', { headers: { 'Content-Type': 'audio/mpeg' } }));
    const result = await request;
    expect(result.time).toBe(7);
    expect(result.blob.size).toBe(6);
  });
  it('uses an estimated timeline for mode switches and still rejects missing paragraphs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('speech')));
    vi.mocked(getChapterAudiobookTimeline).mockResolvedValue({ cues, ready: false, durationSeconds: 16 });
    await expect(loadAudiobookHandoff(ticket, { paragraphIndex: 1 }, new AbortController().signal)).resolves.toMatchObject({ time: 2 });
    vi.mocked(getChapterAudiobookTimeline).mockResolvedValue({ cues, ready: true, durationSeconds: 16 });
    await expect(loadAudiobookHandoff(ticket, { paragraphIndex: 99 }, new AbortController().signal)).rejects.toThrow('无法定位');
  });
  it('cancels a slow generation when switching back or closing the player', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)))));
    const controller = new AbortController();
    const result = expect(loadAudiobookHandoff(ticket, { paragraphIndex: 1 }, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
    controller.abort();
    await result;
    expect(getChapterAudiobookTimeline).not.toHaveBeenCalled();
  });
  it('turns stalled preparation into a recoverable error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)))));
    const result = expect(loadAudiobookHandoff(ticket, { paragraphIndex: 1 }, new AbortController().signal)).rejects.toThrow('准备时间较长');
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
  });
});

class Media extends EventTarget {
  readyState = 0;
  currentTime = 0;
  duration = 16;
  seeking = true;
}

describe('seeking before playback', () => {
  it('waits for metadata and the target seek to finish', async () => {
    const audio = new Media();
    let finished = false;
    const request = seekAudiobookHandoff(audio as unknown as HTMLAudioElement, 7, new AbortController().signal).then(() => { finished = true; });
    expect(audio.currentTime).toBe(0);
    audio.readyState = 1; audio.dispatchEvent(new Event('loadedmetadata'));
    await Promise.resolve();
    expect(audio.currentTime).toBe(7);
    expect(finished).toBe(false);
    audio.seeking = false; audio.dispatchEvent(new Event('seeked'));
    await request;
    expect(finished).toBe(true);
  });
  it('scales an estimated handoff time to the generated audio duration', async () => {
    const audio = new Media();
    audio.duration = 32;
    const request = seekAudiobookHandoff(audio as unknown as HTMLAudioElement, 7, new AbortController().signal, 16);
    audio.readyState = 1; audio.dispatchEvent(new Event('loadedmetadata'));
    await Promise.resolve();
    expect(audio.currentTime).toBe(14);
    audio.seeking = false; audio.dispatchEvent(new Event('seeked'));
    await request;
  });
  it('stops waiting immediately when the player is dismissed', async () => {
    const audio = new Media(), controller = new AbortController();
    const result = expect(seekAudiobookHandoff(audio as unknown as HTMLAudioElement, 7, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
    controller.abort();
    await result;
    audio.readyState = 1; audio.dispatchEvent(new Event('loadedmetadata'));
    expect(audio.currentTime).toBe(0);
  });
});
