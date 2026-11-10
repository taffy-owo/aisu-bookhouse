import type { ReaderChapterBlock } from '../types/reader';

export function mapRenderedBlocksToAudiobookParagraphs(
  rawBlocks: ReaderChapterBlock[],
  renderedBlocks: ReaderChapterBlock[],
): number[][] {
  const rawTextBlocks = rawBlocks.filter((block) => block.type !== 'image');
  const mappings: number[][] = [];
  let rawCursor = 0;

  for (const block of renderedBlocks) {
    if (block.type === 'image') {
      mappings.push([]);
      continue;
    }

    const targetText = normalizeAudiobookParagraphText(block.text);
    const indexes: number[] = [];
    let matchedText = '';
    while (rawCursor < rawTextBlocks.length) {
      const rawBlock = rawTextBlocks[rawCursor];
      const nextText = normalizeAudiobookParagraphText(rawBlock.text);
      if (indexes.length && !targetText.startsWith(`${matchedText}${nextText}`)) break;
      indexes.push(rawCursor);
      matchedText += nextText;
      rawCursor += 1;
      if (matchedText === targetText) break;
    }
    mappings.push(indexes);
  }

  return mappings;
}

function normalizeAudiobookParagraphText(text: string): string {
  return text.replace(/[\u200b-\u200d\ufeff]/gu, '').replace(/[ \t\u3000\r\n]+/gu, ' ').trim();
}
