import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { speakJapaneseSelection } from './japaneseSelectionSpeech';

class Utterance {
  lang = '';
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  readonly text: string;
  constructor(text: string) { this.text = text; }
}
const synth = { cancel: vi.fn(), speak: vi.fn<(utterance: Utterance) => void>(), paused: false, resume: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  synth.paused = false;
  vi.stubGlobal('window', { speechSynthesis: synth });
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
});
afterEach(() => vi.unstubAllGlobals());

describe('selected Japanese device speech', () => {
  it('resumes the device engine when starting a new selection after paused playback', () => {
    synth.paused = true;
    speakJapaneseSelection('桜', vi.fn(), vi.fn());
    expect(synth.resume).toHaveBeenCalledTimes(1);
  });
  it('detaches cancelled callbacks and does not let old events end a later utterance', () => {
    const end = vi.fn(), error = vi.fn();
    const stop = speakJapaneseSelection('桜', end, error);
    const utterance = synth.speak.mock.calls[0][0];
    expect(utterance).toMatchObject({ text: '桜', lang: 'ja-JP', rate: 0.9 });
    const late = utterance.onend!;
    stop(); stop(); late();
    expect(synth.cancel).toHaveBeenCalledTimes(2);
    expect(end).not.toHaveBeenCalled();
    expect(utterance.onend).toBeNull();
  });
  it('does not cancel other speech when cleaned up after completion or interruption', () => {
    const end = vi.fn(), error = vi.fn();
    const stop = speakJapaneseSelection('桜', end, error);
    synth.speak.mock.calls[0][0].onend!();
    stop();
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    const stopNext = speakJapaneseSelection('花', end, error);
    synth.speak.mock.calls[1][0].onerror!({ error: 'interrupted' });
    stopNext();
    expect(synth.cancel).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });
  it('reports unavailable Japanese voices and unsupported browsers', () => {
    const error = vi.fn();
    speakJapaneseSelection('桜', vi.fn(), error);
    synth.speak.mock.calls[0][0].onerror!({ error: 'voice-unavailable' });
    expect(error).toHaveBeenCalledWith('设备没有可用的日语语音，请检查系统语音设置');
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    expect(() => speakJapaneseSelection('桜', vi.fn(), error)).toThrow('当前浏览器不支持设备朗读');
  });
});
