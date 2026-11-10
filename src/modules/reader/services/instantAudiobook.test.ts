import { describe, expect, it } from 'vitest';
import { createInstantAudiobookSegments, detectInstantAudiobookLanguage, splitSpeechText } from './instantAudiobook';

describe('instantAudiobook', () => {
  it('splits long text into mobile-safe short utterances without losing content', () => {
    const source = `第一句。${'很长的内容，'.repeat(30)}最后一句！`;
    const segments = splitSpeechText(source, 80);
    expect(segments.every((segment) => segment.length <= 80)).toBe(true);
    expect(segments.join('')).toBe(source);
  });

  it('keeps paragraph indexes stable and applies simplified display rules', () => {
    const segments = createInstantAudiobookSegments([
      { text: '第一段使用軟體。第二句。', type: 'paragraph' },
      { alt: '插圖', imageUrl: '/image', type: 'image' },
      { level: 2, text: '第二節標題', type: 'heading' },
    ], '', { simplified: true });
    expect(segments).toEqual([
      { paragraphIndex: 0, text: '第一段使用软件。' },
      { paragraphIndex: 0, text: '第二句。' },
      { paragraphIndex: 1, text: '第二节标题' },
    ]);
  });

  it('detects Japanese and Chinese voices from the chapter sample', () => {
    expect(detectInstantAudiobookLanguage([{ paragraphIndex: 0, text: '彼女は静かに笑った。' }])).toBe('ja-JP');
    expect(detectInstantAudiobookLanguage([{ paragraphIndex: 0, text: '她安静地笑了。' }])).toBe('zh-CN');
  });
});
