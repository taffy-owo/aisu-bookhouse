import type { ReaderChapterBlock, ReaderInlineSpan } from '../../reader/types/reader';

const SENTENCE_OR_DIALOGUE_END = /[。！？!?」』）)】〕〗…—]$/u;
const DIALOGUE_OR_SPECIAL_START = /^[「『（(【〔〖〈《＜<]/u;
const DECORATIVE_LINE = /^(?:[＊*※◆◇●○□■△▲▽▼・…—―─]{2,}|[0-9０-９]+)$/u;

export function normalizeJapaneseReadableBlocks(blocks: ReaderChapterBlock[]): ReaderChapterBlock[] {
  const normalized: ReaderChapterBlock[] = [];

  for (const block of blocks) {
    const previous = normalized.at(-1);
    if (previous?.type === 'paragraph' && block.type === 'paragraph' && canJoinJapaneseLineBreak(previous, block)) {
      normalized[normalized.length - 1] = mergeParagraphBlocks(previous, block);
    } else {
      normalized.push(block);
    }
  }

  return normalized;
}

function canJoinJapaneseLineBreak(
  previous: Extract<ReaderChapterBlock, { type: 'paragraph' }>,
  next: Extract<ReaderChapterBlock, { type: 'paragraph' }>,
): boolean {
  const previousText = previous.text.trim();
  const nextText = next.text.trim();
  if (!previousText || !nextText || previousText.length > 64 || DECORATIVE_LINE.test(previousText) || DECORATIVE_LINE.test(nextText)) {
    return false;
  }
  if (SENTENCE_OR_DIALOGUE_END.test(previousText) || DIALOGUE_OR_SPECIAL_START.test(nextText)) {
    return false;
  }
  return true;
}

function mergeParagraphBlocks(
  previous: Extract<ReaderChapterBlock, { type: 'paragraph' }>,
  next: Extract<ReaderChapterBlock, { type: 'paragraph' }>,
): ReaderChapterBlock {
  return {
    spans: [...toSpans(previous), ...toSpans(next)],
    text: `${previous.text}${next.text}`,
    type: 'paragraph',
  };
}

function toSpans(block: Extract<ReaderChapterBlock, { type: 'paragraph' }>): ReaderInlineSpan[] {
  return block.spans?.length && block.spans.map((span) => span.text).join('') === block.text ? block.spans : [{ text: block.text }];
}
