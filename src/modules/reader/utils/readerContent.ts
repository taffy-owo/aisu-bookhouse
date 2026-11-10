import type { ReaderChapterBlock } from '../types/reader';
import { countTextMatches } from './readerMetrics';

export function getDuplicateChapterHeadingIndex(blocks: ReaderChapterBlock[], chapterTitle: string): number {
  const index = blocks.findIndex((block) => block.type === 'heading');
  const block = blocks[index];
  const normalize = (text: string) => text.replace(/[\s\u3000]+/g, '').trim();
  return block?.type === 'heading' && normalize(block.text) === normalize(chapterTitle) ? index : -1;
}

export function countReaderBlockMatches(blocks: ReaderChapterBlock[], query: string, chapterTitle: string): number {
  const duplicate = getDuplicateChapterHeadingIndex(blocks, chapterTitle);
  return blocks.reduce((total, block, index) => total + (index === duplicate || block.type === 'image' ? 0 : countTextMatches(block.text, query)), 0);
}

const EMPTY_CHAPTER_MESSAGE = '这一章还没有可显示的正文。';

/**
 * Return reader blocks without trusting a single collapsed structured block.
 *
 * Older parser results and interrupted uploads can occasionally carry a
 * chapter as one paragraph even though the plain-text representation still
 * contains the original blank-line boundaries.  Prefer the richer blocks in
 * normal cases, but rebuild paragraphs from `content` when that exact failure
 * shape is detected.  Paragraphs containing embedded blank lines are also
 * expanded defensively so CSS never has to guess the document structure.
 */
export function resolveReaderChapterBlocks(
  blocks: ReaderChapterBlock[] | undefined,
  content: string,
): ReaderChapterBlock[] {
  const fallbackParagraphs = splitReaderParagraphs(content);
  if (!blocks?.length) {
    return toParagraphBlocks(fallbackParagraphs);
  }

  const visibleBlocks = blocks.filter((block) => block.type === 'image' || block.text.trim());
  if (!visibleBlocks.length) {
    return toParagraphBlocks(fallbackParagraphs);
  }

  if (
    visibleBlocks.length === 1
    && visibleBlocks[0].type === 'paragraph'
    && fallbackParagraphs.length > 1
    && normalizeComparableText(visibleBlocks[0].text) === normalizeComparableText(fallbackParagraphs.join('\n\n'))
  ) {
    return toParagraphBlocks(fallbackParagraphs);
  }

  return visibleBlocks.flatMap((block) => {
    if (block.type !== 'paragraph' || block.spans?.length || !/\r?\n\s*\r?\n/u.test(block.text)) {
      return [block];
    }
    return toParagraphBlocks(splitReaderParagraphs(block.text));
  });
}

export function splitReaderParagraphs(content: string): string[] {
  const paragraphs = content
    .replace(/\r\n?/gu, '\n')
    .split(/\n\s*\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphs.length ? paragraphs : [EMPTY_CHAPTER_MESSAGE];
}

function toParagraphBlocks(paragraphs: string[]): ReaderChapterBlock[] {
  return paragraphs.map((text) => ({ text, type: 'paragraph' }));
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Flatten chapter blocks into the plain text used for in-chapter search and
 * reading-time estimates. Rich paragraphs/headings contribute their plain
 * `text` (ruby annotations and inline marks are ignored — the base characters
 * are what the reader searches). Image blocks contribute nothing. When no
 * structured blocks exist (legacy plain-text chapters) the raw content is used.
 */
export function getChapterSearchText(blocks: ReaderChapterBlock[] | undefined, content: string): string {
  if (blocks?.length) {
    return blocks
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  return content;
}
