import type { ReaderChapterBlock } from '../types/reader';
import { resolveReaderChapterBlocks } from '../utils/readerContent';
import { convertTraditionalToSimplified } from './chineseScriptConversion';

export type InstantAudiobookSegment = {
  paragraphIndex: number;
  text: string;
};

const DEFAULT_MAX_SEGMENT_CHARACTERS = 110;
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '；', ';', '…']);

export function createInstantAudiobookSegments(
  blocks: ReaderChapterBlock[] | undefined,
  content: string,
  options: { simplified?: boolean; maxCharacters?: number } = {},
): InstantAudiobookSegment[] {
  const maxCharacters = Math.max(40, options.maxCharacters ?? DEFAULT_MAX_SEGMENT_CHARACTERS);
  const textBlocks = resolveReaderChapterBlocks(blocks, content).filter((block) => block.type !== 'image');
  return textBlocks.flatMap((block, paragraphIndex) => {
    const source = options.simplified ? convertTraditionalToSimplified(block.text) : block.text;
    return splitSpeechText(source, maxCharacters).map((text) => ({ paragraphIndex, text }));
  });
}

export function detectInstantAudiobookLanguage(segments: InstantAudiobookSegment[]): 'ja-JP' | 'zh-CN' {
  const sample = segments.slice(0, 20).map((segment) => segment.text).join('');
  const kanaCount = (sample.match(/[\u3040-\u30ff\u31f0-\u31ff]/gu) ?? []).length;
  const compactLength = sample.replace(/\s+/gu, '').length;
  return compactLength > 0 && kanaCount >= Math.max(2, compactLength * 0.01) ? 'ja-JP' : 'zh-CN';
}

export function splitSpeechText(text: string, maxCharacters = DEFAULT_MAX_SEGMENT_CHARACTERS): string[] {
  const normalized = text.replace(/[\u200b-\u200d\ufeff]/gu, '').replace(/[ \t\u3000]+/gu, ' ').trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  let current = '';
  for (const character of normalized) {
    current += character;
    if (SENTENCE_ENDINGS.has(character) || character === '\n') {
      if (current.trim()) sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) sentences.push(current.trim());

  return sentences.flatMap((sentence) => splitLongSpeechUnit(sentence, Math.max(40, maxCharacters)));
}

function splitLongSpeechUnit(text: string, maxCharacters: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters + 1);
    const preferredBoundary = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('、'),
      window.lastIndexOf('：'),
      window.lastIndexOf(':'),
      window.lastIndexOf(' '),
    );
    const boundary = preferredBoundary >= Math.floor(maxCharacters * 0.55) ? preferredBoundary + 1 : maxCharacters;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}
