// Only ship the traditional-to-simplified dictionaries used by the reader.
import OpenCC from 'opencc-js/t2cn';
import type { DictGroup, Trie } from 'opencc-js/core';
import type { ReaderChapterBlock, ReaderInlineSpan, ReaderTocItem } from '../types/reader';

// `twp` includes Taiwan phrase normalization (for example 軟體 -> 软件)
// before the character conversion, which matches the simplified Chinese
// readers expect more closely than a character-only transform.
const traditionalToSimplified = OpenCC.Converter({ from: 'twp', to: 'cn' });

export function convertTraditionalToSimplified(text: string): string {
  return text ? traditionalToSimplified(text) : text;
}

export function convertReaderBlocksToSimplified(blocks: ReaderChapterBlock[]): ReaderChapterBlock[] {
  return blocks.map((block) => {
    if (block.type === 'image') {
      return block.alt ? { ...block, alt: convertTraditionalToSimplified(block.alt) } : block;
    }

    const text = convertTraditionalToSimplified(block.text);
    let spans = block.spans?.map(convertInlineSpanToSimplified);
    if (block.spans?.length && block.spans.map((span) => span.text).join('') === block.text
      && spans?.map((span) => span.text).join('') !== text) {
      spans = convertAcrossInlineBoundaries(block.spans);
    }
    return {
      ...block,
      spans,
      text,
    };
  });
}

export function convertReaderTocToSimplified(toc: ReaderTocItem[]): ReaderTocItem[] {
  return toc.map((item) => ({
    ...item,
    sectionTitle: item.sectionTitle ? convertTraditionalToSimplified(item.sectionTitle) : item.sectionTitle,
    title: convertTraditionalToSimplified(item.title),
  }));
}

function convertInlineSpanToSimplified(span: ReaderInlineSpan): ReaderInlineSpan {
  return {
    ...span,
    ruby: span.ruby ? convertTraditionalToSimplified(span.ruby) : span.ruby,
    text: convertTraditionalToSimplified(span.text),
  };
}

type OwnedCharacter = { text: string; owner: number };
type ConversionPipeline = { normalization: Trie[]; segmentation: Trie; conversion: Trie[] };
let richPipeline: ConversionPipeline | undefined;

function getRichPipeline(): ConversionPipeline {
  if (richPipeline) return richPipeline;
  // Use the same public preset as Converter({ from: 'twp', to: 'cn' }).
  // OpenCC 1.4.2 exposes normalizationChain at runtime but omits it in its types.
  const config = OpenCC.Locale.configs!.tw2sp as NonNullable<typeof OpenCC.Locale.configs>[string] & { normalizationChain?: readonly DictGroup[] };
  const build = (group: DictGroup) => {
    const trie = new OpenCC.Trie();
    trie.loadDictGroup(group);
    return trie;
  };
  const segmentation = new OpenCC.Trie();
  if (Array.isArray(config.segmentation) && config.segmentation.every((entry) => typeof entry === 'string')) {
    segmentation.loadDictGroup(config.segmentation as DictGroup);
  } else {
    segmentation.loadDict(config.segmentation as Parameters<Trie['loadDict']>[0]);
  }
  richPipeline = {
    normalization: (config.normalizationChain ?? []).map(build),
    segmentation,
    conversion: config.conversionChain.map(build),
  };
  return richPipeline;
}

function segmentOwnedText(characters: OwnedCharacter[], trie: Trie): OwnedCharacter[][] {
  let offset = 0;
  return trie.segment(characters.map((character) => character.text).join('')).map((segment) => {
    const length = Array.from(segment).length;
    const result = characters.slice(offset, offset + length);
    offset += length;
    return result;
  });
}

function convertOwnedText(characters: OwnedCharacter[], trie: Trie): OwnedCharacter[] {
  return segmentOwnedText(characters, trie).flatMap((segment) => {
    const source = segment.map((character) => character.text).join('');
    const translated = trie.convert(source);
    if (translated === source) return segment;
    const result = Array.from(translated);
    // A phrase may contract or expand. Distribute only that phrase's original
    // formatting in order; never shift formatting onto adjacent punctuation.
    return result.map((text, index) => ({ text, owner: segment[Math.floor(index * segment.length / result.length)].owner }));
  });
}

function convertAcrossInlineBoundaries(spans: ReaderInlineSpan[]): ReaderInlineSpan[] {
  const pipeline = getRichPipeline();
  const characters = spans.flatMap((span, owner) => Array.from(span.text, (text) => ({ text, owner })));
  const normalized = pipeline.normalization.reduce(convertOwnedText, characters);
  const converted = segmentOwnedText(normalized, pipeline.segmentation)
    .flatMap((segment) => pipeline.conversion.reduce(convertOwnedText, segment));
  const texts = spans.map(() => '');
  converted.forEach(({ text, owner }) => { texts[owner] += text; });
  return spans.map((span, index) => ({ ...convertInlineSpanToSimplified(span), text: texts[index] })).filter((span) => span.text);
}
