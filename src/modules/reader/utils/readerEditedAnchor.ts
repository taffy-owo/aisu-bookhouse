import type { ReaderChapter } from '../types/reader';
import { convertReaderBlocksToSimplified } from '../services/chineseScriptConversion';
import { resolveReaderChapterBlocks } from './readerContent';
import type { ReaderViewportAnchor } from './readerViewportAnchor';

function sourceText(chapter: ReaderChapter, simplified: boolean): string {
  const blocks = resolveReaderChapterBlocks(chapter.blocks, chapter.content);
  // Source offsets exclude paragraph separators, images and ruby readings.
  // Japanese paragraph joining keeps this concatenated text unchanged.
  return (simplified ? convertReaderBlocksToSimplified(blocks) : blocks)
    .map(block => block.type === 'image' ? '' : block.text).join('');
}

export interface ReaderSourceSnapshot {
  text: string;
  signature: string;
}

/** A compact equality check for rendered source, independent of titles and layout. */
export function createReaderSourceSnapshot(chapter: ReaderChapter, simplified = false): ReaderSourceSnapshot {
  const text = sourceText(chapter, simplified);
  let left = 2166136261;
  let right = 5381;
  for (let index = 0; index < text.length; index++) {
    const character = text.charCodeAt(index);
    left = Math.imul(left ^ character, 16777619);
    right = Math.imul(right, 33) ^ character;
  }
  return { text, signature: `${text.length}:${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}` };
}

/** Save only the nearby prose, never an entire chapter in local history. */
export function captureChapterSourceAnchor(anchor: ReaderViewportAnchor | null, source: ReaderSourceSnapshot | null): ReaderViewportAnchor | null {
  if (!anchor || !source || anchor.sourceOffset === undefined || anchor.sourceOffset >= source.text.length) return anchor;
  return {
    ...anchor,
    sourceSignature: source.signature,
    sourceContext: {
      before: source.text.slice(Math.max(0, anchor.sourceOffset - 96), anchor.sourceOffset),
      after: source.text.slice(anchor.sourceOffset, anchor.sourceOffset + 96),
    },
  };
}

function findContextOffset(text: string, context: { before: string; after: string }): number | undefined {
  for (const [quote, relativeOffset] of [
    [context.before + context.after, context.before.length], [context.after, 0], [context.before, context.before.length],
  ] as const) {
    if (quote.length < 16) continue;
    const match = text.indexOf(quote);
    const offset = match + relativeOffset;
    if (match >= 0 && offset < text.length && text.indexOf(quote, match + 1) < 0) return offset;
  }
  return undefined;
}

/** Old absolute offsets are safe only in matching source or uniquely recovered prose. */
export function resolveChapterSourceAnchor(anchor: ReaderViewportAnchor | null | undefined, source: ReaderSourceSnapshot): ReaderViewportAnchor | null {
  if (!anchor || anchor.boundary) return anchor ?? null;
  if (anchor.sourceSignature === source.signature) return anchor;
  const offset = anchor.sourceContext ? findContextOffset(source.text, anchor.sourceContext) : undefined;
  if (offset !== undefined) return captureChapterSourceAnchor({ ...anchor, sourceOffset: offset }, source);
  if (anchor.sourceSignature) return null;
  // Legacy entries have a paragraph excerpt but no checked source. Keep that
  // recovery path without applying an unverified character offset to new text.
  return { ...anchor, sourceOffset: undefined, sourceViewportOffset: undefined };
}

function remapSourceOffset(previous: string, next: string, offset: number): number | undefined {
  if (previous === next) return offset;
  let prefix = 0;
  while (prefix < Math.min(previous.length, next.length) && previous[prefix] === next[prefix]) prefix++;
  if (offset < prefix) return offset;
  let suffix = 0;
  while (suffix < Math.min(previous.length, next.length) - prefix
    && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  if (suffix && offset >= previous.length - suffix) return offset + next.length - previous.length;

  // Independent edits can surround the reading point. Use surviving context
  // only when it is unique, so repeated dialogue cannot select another scene.
  for (const [start, end] of [
    [Math.max(0, offset - 96), Math.min(previous.length, offset + 96)],
    [offset, Math.min(previous.length, offset + 96)],
    [Math.max(0, offset - 96), offset],
  ]) {
    const context = previous.slice(start, end);
    if (context.length < 16) continue;
    const match = next.indexOf(context);
    if (match >= 0 && next.indexOf(context, match + 1) < 0) return match + offset - start;
  }
  return undefined;
}

/** Keep a surviving sentence in place when the chapter itself is edited. */
export function rebaseEditedChapterAnchor(
  anchor: ReaderViewportAnchor | null,
  previous: ReaderChapter | null | undefined,
  next: ReaderChapter,
  simplified = false,
): ReaderViewportAnchor | undefined {
  if (!anchor || !previous) return anchor ?? undefined;
  const before = sourceText(previous, simplified);
  const after = sourceText(next, simplified);
  if (before === after || anchor.boundary) return anchor;
  const sourceOffset = anchor.sourceOffset === undefined ? undefined : remapSourceOffset(before, after, anchor.sourceOffset);
  // If the sentence was removed, the existing paragraph/ratio fallback still
  // gives a nearby readable position instead of using an obsolete offset.
  return captureChapterSourceAnchor({ ...anchor, sourceOffset, sourceViewportOffset: sourceOffset === undefined ? undefined : anchor.sourceViewportOffset,
    sourceSignature: undefined, sourceContext: undefined }, createReaderSourceSnapshot(next, simplified)) ?? undefined;
}
