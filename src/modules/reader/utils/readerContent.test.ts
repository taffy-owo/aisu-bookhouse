import { describe, expect, it } from 'vitest';
import type { ReaderChapterBlock } from '../types/reader';
import { countReaderBlockMatches, getChapterSearchText, resolveReaderChapterBlocks, splitReaderParagraphs } from './readerContent';

describe('rendered chapter search counts', () => {
  it('excludes a duplicate heading hidden by the reader', () => {
    expect(countReaderBlockMatches([{ type: 'heading', level: 1, text: '第 1 话 灯下' }, { type: 'paragraph', text: '灯下的来信' }], '灯下', '第1话 灯下')).toBe(1);
  });
  it('counts displayed subheadings, text paragraphs and repeated matches', () => {
    expect(countReaderBlockMatches([{ type: 'heading', level: 2, text: '灯下' }, { type: 'image', alt: '灯下' }, { type: 'paragraph', text: '灯下，灯下。' }], '灯下', '其他章节')).toBe(3);
  });
  it('does not count text across separate blocks as one visible match', () => {
    expect(countReaderBlockMatches([{ type: 'paragraph', text: '春雨' }, { type: 'paragraph', text: '来信' }], '春雨\n\n来信', '')).toBe(0);
  });
});

describe('getChapterSearchText', () => {
  it('joins paragraph and heading text in order and skips images', () => {
    const blocks: ReaderChapterBlock[] = [
      { level: 2, text: '序幕', type: 'heading' },
      {
        spans: [
          { ruby: 'かんじ', text: '漢字' },
          { marks: ['strong'], text: '重点' },
        ],
        text: '漢字重点',
        type: 'paragraph',
      },
      { imageUrl: 'blob:x', type: 'image' },
      { text: '结尾。', type: 'paragraph' },
    ];

    // Rich spans collapse to their base plain text; the ruby reading is not searched.
    expect(getChapterSearchText(blocks, 'ignored')).toBe('序幕\n\n漢字重点\n\n结尾。');
  });

  it('falls back to raw content when there are no structured blocks', () => {
    expect(getChapterSearchText(undefined, '纯文本内容')).toBe('纯文本内容');
    expect(getChapterSearchText([], '纯文本内容')).toBe('纯文本内容');
  });
});

describe('reader paragraph recovery', () => {
  it('rebuilds a collapsed structured paragraph from the plain-text boundaries', () => {
    const content = '第一段。\n\n第二段。\n\n第三段。';
    expect(resolveReaderChapterBlocks([{ text: '第一段。 第二段。 第三段。', type: 'paragraph' }], content)).toEqual([
      { text: '第一段。', type: 'paragraph' },
      { text: '第二段。', type: 'paragraph' },
      { text: '第三段。', type: 'paragraph' },
    ]);
  });

  it('expands blank lines embedded in a plain paragraph block', () => {
    expect(resolveReaderChapterBlocks([{ text: '第一段。\r\n\r\n第二段。', type: 'paragraph' }], '')).toEqual([
      { text: '第一段。', type: 'paragraph' },
      { text: '第二段。', type: 'paragraph' },
    ]);
  });

  it('preserves rich structured blocks instead of flattening them', () => {
    const blocks: ReaderChapterBlock[] = [
      { level: 2, text: '标题', type: 'heading' },
      { spans: [{ marks: ['strong'], text: '正文' }], text: '正文', type: 'paragraph' },
    ];
    expect(resolveReaderChapterBlocks(blocks, '标题\n\n正文')).toEqual(blocks);
  });

  it('normalizes Windows blank lines and returns an empty-chapter placeholder', () => {
    expect(splitReaderParagraphs('甲\r\n\r\n乙')).toEqual(['甲', '乙']);
    expect(splitReaderParagraphs('  ')).toEqual(['这一章还没有可显示的正文。']);
  });
});
