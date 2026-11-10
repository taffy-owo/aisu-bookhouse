import { apiRequest } from '../../../shared/api';
import type { ReaderChapterBlock, ReaderInlineSpan } from '../../reader/types/reader';

type BackendAnnotationSpan = {
  ruby: string | null;
  text: string;
};

type BackendAnnotationResponse = {
  annotations: Array<{
    spans: BackendAnnotationSpan[];
    text: string;
  }>;
};

type SpanPlan = {
  chunks?: string[];
  source: ReaderInlineSpan;
};

const KANJI_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]/u;
const MAX_BATCH_CHARACTERS = 50_000;
const MAX_BATCH_TEXTS = 300;
const MAX_CHUNK_CHARACTERS = 20_000;
const MAX_CACHE_ENTRIES = 1_000;
const annotationCache = new Map<string, ReaderInlineSpan[]>();

export function hasMissingJapaneseAnnotations(blocks: ReaderChapterBlock[]): boolean {
  return blocks.some((block) => block.type !== 'image' && toSourceSpans(block).some((span) => !span.ruby && KANJI_PATTERN.test(span.text)));
}

export async function annotateJapaneseBlocks(blocks: ReaderChapterBlock[], signal?: AbortSignal): Promise<ReaderChapterBlock[]> {
  const plans = blocks.map((block) => {
    if (block.type === 'image') return null;
    return toSourceSpans(block).map((source): SpanPlan => ({
      chunks: !source.ruby && KANJI_PATTERN.test(source.text) ? splitIntoChunks(source.text) : undefined,
      source,
    }));
  });
  const requestedTexts = plans.flatMap((plan) => plan?.flatMap((span) => span.chunks ?? []) ?? []);

  const annotations = await fetchMissingAnnotations(requestedTexts, signal);

  return blocks.map((block, blockIndex): ReaderChapterBlock => {
    const blockPlan = plans[blockIndex];
    if (block.type === 'image' || !blockPlan) return block;
    const spans = blockPlan.flatMap((plan) => {
      if (!plan.chunks) return [plan.source];
      return plan.chunks.flatMap((chunk) => {
        const generated = annotations.get(chunk) ?? [{ text: chunk }];
        return generated.map((span) => ({ ...span, marks: plan.source.marks }));
      });
    });
    return { ...block, spans };
  });
}

function toSourceSpans(block: Exclude<ReaderChapterBlock, { type: 'image' }>): ReaderInlineSpan[] {
  if (block.spans?.length && block.spans.map((span) => span.text).join('') === block.text) {
    return block.spans;
  }
  return [{ text: block.text }];
}

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_CHUNK_CHARACTERS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function fetchMissingAnnotations(texts: string[], signal?: AbortSignal): Promise<Map<string, ReaderInlineSpan[]>> {
  // The bounded cache is shared between readers. Keep this call's results
  // separately so a long chapter or another reader cannot evict them mid-call.
  const annotations = new Map<string, ReaderInlineSpan[]>();
  const missing: string[] = [];
  for (const text of new Set(texts)) {
    const cached = annotationCache.get(text);
    if (cached) annotations.set(text, cached);
    else missing.push(text);
  }
  let batch: string[] = [];
  let batchCharacters = 0;

  const flush = async () => {
    if (!batch.length) return;
    const response = await apiRequest<BackendAnnotationResponse>('/books/reader/japanese-annotations', {
      body: JSON.stringify({ texts: batch }),
      method: 'POST',
      signal,
    });
    if (response.annotations.length !== batch.length) {
      throw new Error('注音结果不完整，请重试');
    }
    response.annotations.forEach((annotation, index) => {
      const source = batch[index];
      const spans = annotation.spans
        .filter((span) => span.text)
        .map((span) => ({ ruby: span.ruby ?? undefined, text: span.text }));
      if (annotation.text !== source || spans.map((span) => span.text).join('') !== source) {
        throw new Error('注音结果与原文不一致，请重试');
      }
      storeAnnotation(source, spans);
      annotations.set(source, spans);
    });
    batch = [];
    batchCharacters = 0;
  };

  for (const text of missing) {
    if (batch.length >= MAX_BATCH_TEXTS || batchCharacters + text.length > MAX_BATCH_CHARACTERS) {
      await flush();
    }
    batch.push(text);
    batchCharacters += text.length;
  }
  await flush();
  return annotations;
}

function storeAnnotation(text: string, spans: ReaderInlineSpan[]): void {
  annotationCache.delete(text);
  annotationCache.set(text, spans);
  while (annotationCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = annotationCache.keys().next().value;
    if (oldestKey === undefined) break;
    annotationCache.delete(oldestKey);
  }
}
