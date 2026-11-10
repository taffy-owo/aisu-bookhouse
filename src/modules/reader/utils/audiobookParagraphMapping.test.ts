import { describe, expect, it } from 'vitest';
import type { ReaderChapterBlock } from '../types/reader';
import { mapRenderedBlocksToAudiobookParagraphs } from './audiobookParagraphMapping';

describe('mapRenderedBlocksToAudiobookParagraphs', () => {
  it('keeps audio paragraph indexes stable when readable Japanese joins lines', () => {
    const rawBlocks: ReaderChapterBlock[] = [
      { text: 'これは途中で', type: 'paragraph' },
      { text: '折り返された文です。', type: 'paragraph' },
      { alt: '插图', imageUrl: '/image', type: 'image' },
      { text: '次の段落です。', type: 'paragraph' },
    ];
    const renderedBlocks: ReaderChapterBlock[] = [
      { text: 'これは途中で折り返された文です。', type: 'paragraph' },
      rawBlocks[2],
      rawBlocks[3],
    ];

    expect(mapRenderedBlocksToAudiobookParagraphs(rawBlocks, renderedBlocks)).toEqual([[0, 1], [], [2]]);
  });

  it('counts headings in the same text order as audiobook source paragraphs', () => {
    const blocks: ReaderChapterBlock[] = [
      { level: 2, text: '场景一', type: 'heading' },
      { text: '正文。', type: 'paragraph' },
    ];

    expect(mapRenderedBlocksToAudiobookParagraphs(blocks, blocks)).toEqual([[0], [1]]);
  });
});
