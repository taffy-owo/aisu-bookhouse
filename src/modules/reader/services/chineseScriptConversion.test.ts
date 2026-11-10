import { describe, expect, it } from 'vitest';
import type { ReaderInlineSpan } from '../types/reader';
import {
  convertReaderBlocksToSimplified,
  convertReaderTocToSimplified,
  convertTraditionalToSimplified,
} from './chineseScriptConversion';

describe('chineseScriptConversion', () => {
  it('converts traditional Chinese immediately with mainland phrase-aware rules', () => {
    expect(convertTraditionalToSimplified('繁體中文與軟體開發')).toBe('繁体中文与软件开发');
  });

  it('preserves reader structure while converting text, spans and image alt text', () => {
    expect(convertReaderBlocksToSimplified([
      { spans: [{ marks: ['strong'], text: '這是一段話' }], text: '這是一段話', type: 'paragraph' },
      { alt: '插圖說明', imageUrl: '/image', type: 'image' },
    ])).toEqual([
      { spans: [{ marks: ['strong'], text: '这是一段话' }], text: '这是一段话', type: 'paragraph' },
      { alt: '插图说明', imageUrl: '/image', type: 'image' },
    ]);
  });

  it('converts table-of-contents titles without changing navigation indexes', () => {
    expect(convertReaderTocToSimplified([{ index: 1, sectionTitle: '第一卷', title: '第一章 相遇' }])).toEqual([
      { index: 1, sectionTitle: '第一卷', title: '第一章 相遇' },
    ]);
  });

  it('converts a regional phrase across emphasis boundaries without changing its visible text during search', () => {
    const [block] = convertReaderBlocksToSimplified([{
      type: 'paragraph', text: '軟體開發',
      spans: [{ text: '軟', marks: ['strong'] }, { text: '體', marks: ['emphasis'] }, { text: '開發' }],
    }]);
    expect(block).toEqual({
      type: 'paragraph', text: '软件开发',
      spans: [{ text: '软', marks: ['strong'] }, { text: '件', marks: ['emphasis'] }, { text: '开发' }],
    });
  });

  it('keeps formatting on a contracted phrase instead of spilling it onto following text', () => {
    const [block] = convertReaderBlocksToSimplified([{
      type: 'paragraph', text: '網際網路，繼續閱讀。',
      spans: [{ text: '網際', marks: ['strong'] }, { text: '網路', marks: ['emphasis'] }, { text: '，繼續閱讀。' }],
    }]);
    expect(block).toEqual({
      type: 'paragraph', text: '互联网，继续阅读。',
      spans: [{ text: '互联', marks: ['strong'] }, { text: '网', marks: ['emphasis'] }, { text: '，继续阅读。' }],
    });
  });

  it('retains ruby, supplementary characters and source objects', () => {
    const spans: ReaderInlineSpan[] = [{ text: '🌸軟', marks: ['strong'], ruby: '花與軟' }, { text: '體𠮷', marks: ['emphasis_dot'] }];
    const original = structuredClone(spans);
    const [block] = convertReaderBlocksToSimplified([{ type: 'paragraph', text: '🌸軟體𠮷', spans }]);
    expect(block).toEqual({ type: 'paragraph', text: '🌸软件𠮷', spans: [
      { text: '🌸软', marks: ['strong'], ruby: '花与软' }, { text: '件𠮷', marks: ['emphasis_dot'] },
    ] });
    expect(spans).toEqual(original);
  });

  it('matches whole-text conversion at every formatting boundary, including normalization and mixed scripts', () => {
    for (const text of ['這個軟體在網際網路上執行。', '記憶體與滑鼠、隨身碟和計程車。', '🌸軟體𠮷與乾坤、頭髮和發展。', '⿰氵㐱和軟體。', '繁體中文、臺灣軟體，HTML & <tag>。']) {
      const characters = Array.from(text);
      for (let boundary = 1; boundary < characters.length; boundary += 1) {
        const [block] = convertReaderBlocksToSimplified([{
          type: 'heading', level: 2, text,
          spans: [{ text: characters.slice(0, boundary).join(''), marks: ['strong'] }, { text: characters.slice(boundary).join(''), marks: ['emphasis'] }],
        }]);
        expect(block.type).toBe('heading');
        if (block.type !== 'image') expect(block.spans?.map((span) => span.text).join('')).toBe(convertTraditionalToSimplified(text));
      }
    }
  });

  it('keeps conversion stable across many independently styled phrases and empty spans', () => {
    const spans: ReaderInlineSpan[] = Array.from({ length: 300 }, () => [{ text: '軟', marks: ['strong'] as const }, { text: '' }, { text: '體。' }])
      .flat().map((span) => ({ ...span, marks: span.marks ? [...span.marks] : undefined }));
    const [block] = convertReaderBlocksToSimplified([{ type: 'paragraph', text: '軟體。'.repeat(300), spans }]);
    if (block.type === 'image') throw Error('Expected paragraph');
    expect(block.spans?.map((span) => span.text).join('')).toBe('软件。'.repeat(300));
    expect(block.spans?.filter((span) => span.marks?.includes('strong')).map((span) => span.text)).toEqual(Array(300).fill('软'));
  });
});
