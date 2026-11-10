import { apiRequest } from '../../../shared/api';
import { getAccountScope } from '../../../shared/api/authTokenStore';

type BackendJapaneseAiTranslation = {
  model: string;
  translations: string[];
};

type TranslationOptions = {
  context?: {
    chapterTitle?: string;
    workTitle?: string;
  };
  onProgress?: (translations: Map<string, string>) => void;
  signal?: AbortSignal;
};

const MAX_BATCH_CHARACTERS = 6_000;
const MAX_BATCH_TEXTS = 12;
const MAX_CACHE_ENTRIES = 2_000;
const translationCache = new Map<string, string>();
type TranslationBatch = {
  keys: string[];
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<Map<string, string>>;
  settled: boolean;
};
const pendingTranslations = new Map<string, TranslationBatch>();
let cacheGeneration = 0;

export function clearJapaneseAiTranslationCache(): void {
  cacheGeneration += 1;
  translationCache.clear();
  for (const batch of new Set(pendingTranslations.values())) batch.controller.abort();
  pendingTranslations.clear();
}

export async function translateJapaneseTexts(texts: string[], options: TranslationOptions = {}): Promise<Map<string, string>> {
  const plans = [...new Set(texts.map((text) => text.trim()).filter(Boolean))]
    .map((text) => ({ text, chunks: splitTranslationText(text) }));
  const assemble = (chunks: Map<string, string>) => new Map(plans
    .filter((plan) => plan.chunks.every((chunk) => chunks.has(chunk.text)))
    .map((plan) => [plan.text, plan.chunks.map((chunk) => chunks.get(chunk.text)! + chunk.separator).join('')]));
  const result = await translateJapaneseChunks(plans.flatMap((plan) => plan.chunks.map((chunk) => chunk.text)), {
    ...options,
    onProgress: options.onProgress ? (chunks) => options.onProgress?.(assemble(chunks)) : undefined,
  });
  return assemble(result);
}

// Keep source paragraphs as the display/cache consumer unit, but split an
// oversized paragraph into bounded requests, preferably at sentence endings.
function splitTranslationText(text: string): { text: string; separator: string }[] {
  const chunks: { text: string; separator: string }[] = [];
  let start = 0;
  while (text.length - start > MAX_BATCH_CHARACTERS) {
    let end = start + MAX_BATCH_CHARACTERS;
    // Never split a supplementary character into invalid surrogate halves.
    if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end -= 1;
    const part = text.slice(start, end);
    const endings = [...part.matchAll(/(?:[。！？!?]|\.(?=\s|$))[」』”’"）)]*|\r?\n/gu)];
    const last = endings.at(-1);
    const boundary = last ? last.index + last[0].length : part.lastIndexOf(' ');
    if (boundary >= MAX_BATCH_CHARACTERS / 2) end = start + boundary;
    // Keep boundary whitespace outside the translation request so trimming
    // provider responses cannot glue words together or remove a line break.
    const followingWhitespace = text.slice(end).match(/^\s*/u)?.[0] ?? '';
    end += followingWhitespace.length;
    const raw = text.slice(start, end);
    const chunk = raw.trimEnd();
    if (chunk) chunks.push({ text: chunk, separator: raw.slice(chunk.length) });
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) chunks.push({ text: tail, separator: '' });
  return chunks;
}

function translationContextTitle(value = ''): string | Promise<string> {
  const title = value.trim();
  const characters = Array.from(title);
  if (characters.length <= 255) return title;
  // The server hashes these titles for cache ownership. Preserve full-title
  // identity when shortening context to its Unicode-code-point limit.
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(title)).then((digest) => {
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const suffix = `… [context:${hash}]`;
    return characters.slice(0, 255 - suffix.length).join('') + suffix;
  });
}

async function translateJapaneseChunks(texts: string[], options: TranslationOptions): Promise<Map<string, string>> {
  const owner = getAccountScope();
  const generation = cacheGeneration;
  const contextKey = JSON.stringify({
    accountScope: owner,
    chapterTitle: options.context?.chapterTitle?.trim() ?? '',
    workTitle: options.context?.workTitle?.trim() ?? '',
  });
  const keyFor = (text: string) => `${contextKey}\u0000${text}`;
  const translations = new Map<string, string>();
  const uniqueTexts = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  const wanted = new Set(uniqueTexts);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const ensureActive = () => {
    if (lifetime.signal.aborted || generation !== cacheGeneration || owner !== getAccountScope()) throw translationAborted();
  };

  try {
    ensureActive();
    for (const text of uniqueTexts) {
      const cached = translationCache.get(keyFor(text));
      if (cached) translations.set(text, cached);
    }
    options.onProgress?.(new Map(translations));
    let cursor = 0;
    while (cursor < uniqueTexts.length) {
      ensureActive();
      const batches = new Set<TranslationBatch>();
      const missing: string[] = [];
      let characters = 0;
      // Recheck both caches after each awaited batch: a selection may have
      // translated a later paragraph while this chapter was still running.
      for (; cursor < uniqueTexts.length; cursor += 1) {
        const text = uniqueTexts[cursor];
        if (translations.has(text)) continue;
        const key = keyFor(text);
        const cached = translationCache.get(key);
        if (cached) { translations.set(text, cached); continue; }
        const pending = pendingTranslations.get(key);
        if (pending && !pending.controller.signal.aborted) { batches.add(pending); continue; }
        if (missing.length && (missing.length >= MAX_BATCH_TEXTS || characters + text.length > MAX_BATCH_CHARACTERS)) break;
        missing.push(text);
        characters += text.length;
      }
      if (missing.length) {
        batches.add(startTranslationBatch(missing, keyFor, options.context, owner, generation));
      }
      await Promise.all([...batches].map(async (batch) => {
        const result = await consumeTranslationBatch(batch, lifetime.signal);
        ensureActive();
        for (const [text, translation] of result) {
          if (wanted.has(text)) translations.set(text, translation);
        }
        options.onProgress?.(new Map(translations));
      }));
    }
    ensureActive();
    return translations;
  } finally {
    // Leaving one reader cancels only its interest. A shared request lives on
    // while another chapter or sentence consumer still needs its response.
    lifetime.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}

function startTranslationBatch(texts: string[], keyFor: (text: string) => string, context: TranslationOptions['context'], owner: string, generation: number): TranslationBatch {
  let resolve!: (value: Map<string, string>) => void;
  let reject!: (reason: unknown) => void;
  const batch: TranslationBatch = {
    keys: texts.map(keyFor),
    controller: new AbortController(),
    consumers: new Set(),
    promise: new Promise((done, fail) => { resolve = done; reject = fail; }),
    settled: false,
  };
  for (const key of batch.keys) pendingTranslations.set(key, batch);
  const run = async () => {
    try {
      const chapter = translationContextTitle(context?.chapterTitle);
      const work = translationContextTitle(context?.workTitle);
      const [chapterTitle, workTitle] = typeof chapter === 'string' && typeof work === 'string'
        ? [chapter, work] : await Promise.all([chapter, work]);
      if (batch.controller.signal.aborted || generation !== cacheGeneration || owner !== getAccountScope()) throw translationAborted();
      const response = await apiRequest<BackendJapaneseAiTranslation>('/books/reader/japanese-ai-translation', {
        body: JSON.stringify({
          chapter_title: chapterTitle,
          texts,
          work_title: workTitle,
        }),
        method: 'POST',
        signal: batch.controller.signal,
      });
      if (batch.controller.signal.aborted || generation !== cacheGeneration || owner !== getAccountScope()) throw translationAborted();
      if (!Array.isArray(response.translations) || response.translations.length !== texts.length) {
        throw new Error('AI 译文数量与原文不一致，请重试');
      }
      const translated = response.translations.map((value) => typeof value === 'string' ? value.trim() : '');
      if (translated.some((value) => !value)) throw new Error('AI 返回了空译文，请重试');
      const result = new Map(texts.map((text, index) => [text, translated[index]]));
      for (const [text, translation] of result) storeTranslation(keyFor(text), translation);
      return result;
    } finally {
      batch.settled = true;
      removePendingBatch(batch);
    }
  };
  void run().then(resolve, reject);
  // All consumers can cancel before a transport observes abort.
  void batch.promise.catch(() => undefined);
  return batch;
}

function consumeTranslationBatch(batch: TranslationBatch, signal: AbortSignal): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const consumer = Symbol();
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      signal.removeEventListener('abort', handleAbort);
      batch.controller.signal.removeEventListener('abort', handleAbort);
      batch.consumers.delete(consumer);
      if (!batch.settled && batch.consumers.size === 0) {
        batch.controller.abort();
        removePendingBatch(batch);
      }
    };
    const handleAbort = () => { cleanup(); reject(translationAborted()); };
    if (signal.aborted || batch.controller.signal.aborted) { handleAbort(); return; }
    batch.consumers.add(consumer);
    signal.addEventListener('abort', handleAbort, { once: true });
    batch.controller.signal.addEventListener('abort', handleAbort, { once: true });
    void batch.promise.then((result) => {
      if (!active) return;
      cleanup();
      resolve(result);
    }, (error: unknown) => {
      if (!active) return;
      cleanup();
      reject(error);
    });
  });
}

function removePendingBatch(batch: TranslationBatch): void {
  for (const key of batch.keys) {
    if (pendingTranslations.get(key) === batch) pendingTranslations.delete(key);
  }
}

function translationAborted(): DOMException {
  return new DOMException('翻译已取消', 'AbortError');
}

function storeTranslation(text: string, translation: string): void {
  translationCache.delete(text);
  translationCache.set(text, translation);
  while (translationCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey === undefined) break;
    translationCache.delete(oldestKey);
  }
}
