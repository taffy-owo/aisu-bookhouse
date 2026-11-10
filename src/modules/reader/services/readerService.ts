import { notifyReaderContentConflict } from './readerContentConflict';
import { apiRequest, assertAccountScope, buildApiResourceUrl, getAccountScope, isBackendApiEnabled } from '../../../shared/api';
import { getBookById, invalidateBookListCache } from '../../books';
import type { Book, ReaderType } from '../../books';
import type { BackendBook } from '../../books/services/bookApiTypes';
import { mapBackendBook } from '../../books/services/bookMappers';
import type { ReaderChapter, ReaderChapterBlock, ReaderInlineMark, ReaderInlineSpan, ReaderMark, ReaderResource, ReadingProgress } from '../types/reader';
import { getRawReadingProgress, READING_PROGRESS_SAVED_EVENT, saveReadingProgress as storeSaveReadingProgress } from '../../reading-progress';
import { mapBackendReaderMark, type BackendReaderMark } from './readerMarkService';
import { normalizeProgressTimestamp, observeReadingProgressTimestamp } from './progressTimestamp';
import { mapBackendReadingProgress, type BackendReadingProgress } from './readingProgressMappers';
import { compareAppTimestamps } from '../../../shared/utils/formatDate';

type BackendReaderResource = {
  position_key?: string | null;
  version?: string | null;
  chapter_count: number | null;
  cover_url: string | null;
  file_url: string | null;
  page_count: number | null;
  pages: Array<{ image_url: string | null; index: number; position_key?: string | null }>;
  reader_type: ReaderType;
  toc: Array<{ content_version?: string | null; position_key?: string | null; index: number; level?: number; progress_weight: number | null; section_level?: number; section_title?: string | null; title: string }>;
};

type BackendReaderChapter = {
  content_version?: string | null;
  position_key?: string | null;
  blocks?: BackendReaderChapterBlock[];
  content: string;
  index: number;
  title: string;
};

type BackendReaderInlineSpan = {
  marks?: Array<'strong' | 'emphasis' | 'emphasis_dot'> | null;
  ruby?: string | null;
  text: string | null;
};

type BackendReaderChapterBlock = {
  alt?: string | null;
  image_height?: number | null;
  image_url?: string | null;
  image_width?: number | null;
  level?: number | null;
  spans?: BackendReaderInlineSpan[] | null;
  text?: string | null;
  type: 'paragraph' | 'heading' | 'image';
};

type BackendReaderStartup = {
  book: BackendBook;
  chapter: BackendReaderChapter | null;
  marks: BackendReaderMark[];
  progress: BackendReadingProgress;
  resource: BackendReaderResource;
};

export type ReaderStartup = {
  book: Book;
  chapter: ReaderChapter | null;
  marks: ReaderMark[];
  progress: ReadingProgress;
  resource: ReaderResource;
};

export type ChapterAudiobookTicket = {
  audioUrl: string;
  cached: boolean;
  chapterIndex: number;
  timelineUrl: string;
};

export type AudiobookTimelineCue = {
  endSeconds: number;
  paragraphIndex: number;
  startSeconds: number;
};

export type AudiobookTimeline = {
  cues: AudiobookTimelineCue[];
  durationSeconds: number;
  ready: boolean;
};

export async function getReaderStartup(bookId: string, chapterIndex?: number, signal?: AbortSignal): Promise<ReaderStartup> {
  if (isBackendApiEnabled()) {
    const searchParams = new URLSearchParams();
    if (chapterIndex) {
      searchParams.set('chapter_index', String(chapterIndex));
    }
    const query = searchParams.toString();
    const scope = getAccountScope();
    const startup = await apiRequest<BackendReaderStartup>(`/books/${bookId}/reader/startup${query ? `?${query}` : ''}`, { signal });
    observeReaderResourceVersion(bookId, startup.resource, scope, signal);
    return {
      book: mapBackendBook(startup.book),
      chapter: startup.chapter ? mapBackendReaderChapter(startup.chapter) : null,
      marks: startup.marks.map(mapBackendReaderMark),
      progress: mapBackendReadingProgress(startup.progress, scope),
      resource: mapBackendReaderResource(startup.resource),
    };
  }

  const book = await getRequiredBook(bookId);
  const resource = createLocalReaderResource(book);
  const progress = await getReadingProgress(bookId, signal);
  const resolvedChapterIndex = chapterIndex ?? progress.chapterIndex ?? 1;
  const chapter = book.readerType === 'comic' || book.readerType === 'image' || book.readerType === 'pdf' || book.readerType === 'unsupported'
    ? null
    : await getReaderChapter(bookId, resolvedChapterIndex, signal);

  return {
    book,
    chapter,
    marks: [],
    progress,
    resource,
  };
}

export async function getReaderResource(bookId: string, signal?: AbortSignal): Promise<ReaderResource> {
  if (isBackendApiEnabled()) {
    const scope = getAccountScope();
    const resource = await apiRequest<BackendReaderResource>(`/books/${bookId}/reader`, { signal });
    observeReaderResourceVersion(bookId, resource, scope, signal);
    return mapBackendReaderResource(resource);
  }

  const book = await getRequiredBook(bookId);
  return createLocalReaderResource(book);
}

// Small LRU of recently fetched chapters so paging into the next chapter is
// instant: the reader prefetches chapter N+1 while N is being read.
const CHAPTER_CACHE_LIMIT = 8;
const chapterCache = new Map<string, ReaderChapter>();
interface ChapterLoad {
  bookId: string;
  cacheKey: string;
  invalidated: boolean;
  promise: Promise<ReaderChapter>;
  scope: string;
}
interface ChapterWarmup { bookId: string; invalidated: boolean; scope: string }
const chapterPrefetches = new Map<string, ChapterLoad>();
const activeChapterLoads = new Set<ChapterLoad>();
const activeChapterWarmups = new Set<ChapterWarmup>();
const readerResourceVersions = new Map<string, { identity: string; version?: string | null }>();
const RESOURCE_VERSION_LIMIT = 80;

function getChapterCacheKey(bookId: string, chapterIndex: number): string {
  return JSON.stringify([getAccountScope(), bookId, chapterIndex]);
}

function storeChapterInCache(key: string, chapter: ReaderChapter): void {
  chapterCache.delete(key);
  chapterCache.set(key, chapter);
  while (chapterCache.size > CHAPTER_CACHE_LIMIT) {
    const oldestKey = chapterCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    chapterCache.delete(oldestKey);
  }
}

function startChapterLoad(bookId: string, chapterIndex: number, signal?: AbortSignal): ChapterLoad {
  const cacheKey = getChapterCacheKey(bookId, chapterIndex);
  const scope = getAccountScope();
  const load: ChapterLoad = {
    bookId, cacheKey, invalidated: false, scope,
    promise: fetchReaderChapter(bookId, chapterIndex, signal)
      .then((chapter) => {
        if (!load.invalidated && !signal?.aborted && scope === getAccountScope()) storeChapterInCache(cacheKey, chapter);
        return chapter;
      })
      .finally(() => { activeChapterLoads.delete(load); }),
  };
  activeChapterLoads.add(load);
  return load;
}

export async function getReaderChapter(bookId: string, chapterIndex: number, signal?: AbortSignal): Promise<ReaderChapter> {
  const cacheKey = getChapterCacheKey(bookId, chapterIndex);
  const cachedChapter = chapterCache.get(cacheKey);
  if (cachedChapter) {
    storeChapterInCache(cacheKey, cachedChapter);
    return cachedChapter;
  }

  const load = chapterPrefetches.get(cacheKey) ?? startChapterLoad(bookId, chapterIndex, signal);
  const shouldRetry = () => load.invalidated && !signal?.aborted && load.scope === getAccountScope();
  try {
    const chapter = await load.promise;
    // A caller already awaiting an obsolete prefetch must also receive the
    // new edition, rather than just protecting the cache for the next caller.
    return shouldRetry() ? getReaderChapter(bookId, chapterIndex, signal) : chapter;
  } catch (error) {
    if (shouldRetry()) return getReaderChapter(bookId, chapterIndex, signal);
    throw error;
  }
}

/** Fire-and-forget warmup for the chapter the reader is about to need. */
export function prefetchReaderChapter(bookId: string, chapterIndex: number): Promise<void> {
  const cacheKey = getChapterCacheKey(bookId, chapterIndex);
  if (chapterCache.has(cacheKey) || chapterPrefetches.has(cacheKey)) {
    return chapterPrefetches.get(cacheKey)?.promise.then(() => undefined, () => undefined) ?? Promise.resolve();
  }

  const load = startChapterLoad(bookId, chapterIndex);
  chapterPrefetches.set(cacheKey, load);
  return load.promise.then(() => undefined, () => undefined).finally(() => {
    if (chapterPrefetches.get(cacheKey) === load) chapterPrefetches.delete(cacheKey);
  });
}

export async function prepareChapterAudiobook(bookId: string, chapterIndex: number, signal?: AbortSignal): Promise<ChapterAudiobookTicket> {
  if (!isBackendApiEnabled()) {
    throw new Error('本地示例书不支持听书');
  }
  const ticket = await apiRequest<{ audio_url: string; cached: boolean; chapter_index: number; timeline_url: string }>(`/books/${bookId}/reader/chapters/${chapterIndex}/audiobook`, {
    method: 'POST',
    signal,
  });
  return {
    audioUrl: buildApiResourceUrl(ticket.audio_url) ?? ticket.audio_url,
    cached: ticket.cached,
    chapterIndex: ticket.chapter_index,
    timelineUrl: buildApiResourceUrl(ticket.timeline_url) ?? ticket.timeline_url,
  };
}

export async function getChapterAudiobookTimeline(timelineUrl: string, signal?: AbortSignal): Promise<AudiobookTimeline> {
  const response = await fetch(timelineUrl, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('听书跟随时间轴加载失败');
  const payload = await response.json() as {
    cues?: Array<{ end_seconds?: number; paragraph_index?: number; start_seconds?: number }>;
    duration_seconds?: number;
    ready?: boolean;
  };
  const cues = (payload.cues ?? []).flatMap((cue) => {
    if (
      typeof cue.end_seconds !== 'number'
      || typeof cue.paragraph_index !== 'number'
      || typeof cue.start_seconds !== 'number'
      || cue.end_seconds <= cue.start_seconds
    ) return [];
    return [{ endSeconds: cue.end_seconds, paragraphIndex: cue.paragraph_index, startSeconds: cue.start_seconds }];
  });
  return {
    cues,
    durationSeconds: typeof payload.duration_seconds === 'number' ? payload.duration_seconds : 0,
    ready: payload.ready === true,
  };
}

export async function prefetchReaderChapters(bookId: string, chapterIndexes: readonly number[]): Promise<void> {
  const warmup: ChapterWarmup = { bookId, invalidated: false, scope: getAccountScope() };
  activeChapterWarmups.add(warmup);
  try {
    for (const chapterIndex of chapterIndexes) {
      if (warmup.invalidated || warmup.scope !== getAccountScope()) break;
      await prefetchReaderChapter(bookId, chapterIndex);
    }
  } finally {
    activeChapterWarmups.delete(warmup);
  }
}

function invalidateChapterCache(bookId?: string, scope = getAccountScope()): void {
  const matches = (key: string) => {
    if (bookId === undefined) return true;
    const [keyScope, keyBookId] = JSON.parse(key) as [string, string];
    return keyScope === scope && keyBookId === bookId;
  };
  for (const key of chapterCache.keys()) if (matches(key)) chapterCache.delete(key);
  for (const key of chapterPrefetches.keys()) if (matches(key)) chapterPrefetches.delete(key);
  activeChapterLoads.forEach((load) => { if (matches(load.cacheKey)) load.invalidated = true; });
  activeChapterWarmups.forEach((warmup) => {
    if (bookId === undefined || (warmup.bookId === bookId && warmup.scope === scope)) warmup.invalidated = true;
  });
}

export function resetReaderChapterCache(bookId?: string): void {
  invalidateChapterCache(bookId);
  if (bookId === undefined) readerResourceVersions.clear();
  else readerResourceVersions.delete(JSON.stringify([getAccountScope(), bookId]));
}

function observeReaderResourceVersion(bookId: string, resource: BackendReaderResource, scope: string, signal?: AbortSignal): void {
  if (signal?.aborted || scope !== getAccountScope()) return;
  const key = JSON.stringify([scope, bookId]);
  const previous = readerResourceVersions.get(key);
  const identity = resource.version || JSON.stringify([resource.reader_type, resource.chapter_count, resource.toc]);
  // Backend versions are book timestamps. A late older resource read must not
  // invalidate a newer edition or make its cached chapters appear current.
  if (compareAppTimestamps(resource.version ?? '', previous?.version ?? '') < 0) return;
  if (previous && previous.identity !== identity) invalidateChapterCache(bookId, scope);
  readerResourceVersions.delete(key);
  readerResourceVersions.set(key, { identity, version: resource.version });
  while (readerResourceVersions.size > RESOURCE_VERSION_LIMIT) {
    const oldest = readerResourceVersions.keys().next().value;
    if (oldest === undefined) break;
    readerResourceVersions.delete(oldest);
  }
}

async function fetchReaderChapter(bookId: string, chapterIndex: number, signal?: AbortSignal): Promise<ReaderChapter> {
  if (isBackendApiEnabled()) {
    const chapter = await apiRequest<BackendReaderChapter>(`/books/${bookId}/reader/chapters/${chapterIndex}`, { signal });
    return mapBackendReaderChapter(chapter);
  }

  const localBook = await getRequiredBook(bookId);
  return {
    content: localBook.language === 'ja' ? createLocalJapaneseChapterContent() : createLocalChapterContent(),
    index: chapterIndex,
    title: `第 ${chapterIndex} 章 / 柔光片段`,
  };
}

function mapBackendReaderChapter(chapter: BackendReaderChapter): ReaderChapter {
  return { contentVersion: chapter.content_version ?? undefined, positionKey: chapter.position_key ?? undefined, blocks: mapBackendReaderChapterBlocks(chapter.blocks), content: chapter.content, index: chapter.index, title: chapter.title };
}

export function mapBackendReaderChapterBlocks(blocks: BackendReaderChapterBlock[] | undefined): ReaderChapter['blocks'] {
  if (!blocks?.length) {
    return undefined;
  }

  return blocks
    .map((block): ReaderChapterBlock | null => {
      if (block.type === 'image') {
        return {
          alt: block.alt ?? undefined,
          imageHeight: toPositiveInteger(block.image_height),
          imageUrl: buildApiResourceUrl(block.image_url),
          imageWidth: toPositiveInteger(block.image_width),
          type: 'image',
        };
      }

      const text = block.text ?? '';
      const spans = mapBackendReaderInlineSpans(block.spans);
      if (block.type === 'heading') {
        return { level: clampHeadingLevel(block.level), spans, text, type: 'heading' };
      }

      return { spans, text, type: 'paragraph' };
    })
    .filter((block): block is ReaderChapterBlock => block !== null)
    .filter((block) => block.type === 'image' || block.text.trim());
}

function mapBackendReaderInlineSpans(spans: BackendReaderInlineSpan[] | null | undefined): ReaderInlineSpan[] | undefined {
  if (!spans?.length) {
    return undefined;
  }

  const mapped = spans
    .map((span): ReaderInlineSpan | null => {
      if (typeof span?.text !== 'string' || !span.text) {
        return null;
      }
      const marks = Array.isArray(span.marks)
        ? span.marks.filter((mark): mark is ReaderInlineMark => mark === 'strong' || mark === 'emphasis' || mark === 'emphasis_dot')
        : [];
      const ruby = typeof span.ruby === 'string' && span.ruby ? span.ruby : undefined;
      return { marks: marks.length ? marks : undefined, ruby, text: span.text };
    })
    .filter((span): span is ReaderInlineSpan => span !== null);

  return mapped.length ? mapped : undefined;
}

function clampHeadingLevel(level: number | null | undefined): number {
  return typeof level === 'number' && level >= 1 && level <= 6 ? Math.floor(level) : 2;
}

function toPositiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function createLocalChapterContent(): string {
  return [
    '窗外的风带着海盐的味道，轻轻掠过旧校舍。',
    '有些话，说出来会让彼此都变得笨拙；有些情绪，只有在安静里才会清晰。',
    '于是她终于明白，所谓告白并不一定需要盛大的台词。',
  ].join('\n\n');
}

function createLocalJapaneseChapterContent(): string {
  return [
    '窓の外から、潮の匂いを含んだ風が古い校舎へと流れ込んできた。',
    '「まだ、ここにいたんだ」',
    '振り返ると、彼女は読みかけの本を胸に抱えたまま、少し困ったように笑っていた。',
    '言葉にすれば壊れてしまいそうな気持ちほど、静かな時間の中ではっきりと見えてくる。',
  ].join('\n\n');
}

export async function getReadingProgress(bookId: string, signal?: AbortSignal): Promise<ReadingProgress> {
  if (isBackendApiEnabled()) {
    const scope = getAccountScope();
    const progress = await apiRequest<BackendReadingProgress>(`/books/${bookId}/progress`, { signal });
    return mapBackendReadingProgress(progress, scope);
  }

  const book = await getRequiredBook(bookId);
  const savedProgress = getRawReadingProgress(bookId);

  if (savedProgress) {
    return savedProgress;
  }

  return {
    bookId,
    chapterIndex: book.readerType === 'comic' || book.readerType === 'image' ? undefined : 12,
    imageIndex: book.readerType === 'comic' || book.readerType === 'image' ? 12 : undefined,
    progressPercent: book.progressPercent,
    readerType: book.readerType,
    updatedAt: new Date().toISOString(),
  };
}

export async function saveReadingProgress(bookId: string, progress: ReadingProgress, options: { keepalive?: boolean } = {}): Promise<void> {
  const scope = getAccountScope();
  if (bookId !== progress.bookId) {
    throw new Error(`阅读进度保存失败：${bookId} 与进度记录不匹配`);
  }

  if (isBackendApiEnabled()) {
    // The book is only needed as a fallback for reader_type; progress already
    // carries it during normal reading, so avoid an extra GET on every autosave.
    const readerType = progress.readerType ?? (await getRequiredBook(bookId)).readerType;
    assertAccountScope(scope);
    try {
      const saved = await apiRequest<BackendReadingProgress>(`/books/${bookId}/progress`, {
        body: JSON.stringify({
          ...(progress.positionKey ? { position_key: progress.positionKey } : {}),
          ...(progress.contentVersion ? { content_version: progress.contentVersion } : {}),
          chapter_href: progress.chapterHref ?? null,
          chapter_index: progress.chapterIndex ?? null,
          epub_cfi: progress.epubCfi ?? null,
          image_index: progress.imageIndex ?? null,
          page_number: progress.pageNumber ?? null,
          progress_percent: progress.progressPercent,
          reader_type: readerType,
          updated_at: normalizeProgressTimestamp(progress.updatedAt),
        }),
        // keepalive lets pagehide/visibility flushes survive page teardown.
        keepalive: options.keepalive,
        method: 'PUT',
      });
      // A concurrent device may have won the write. Its response is still a
      // clock boundary for the next actual local reading action; retries keep
      // the original queued time so they cannot override newer remote intent.
      if (saved?.book_id === bookId && typeof saved.updated_at === 'string') observeReadingProgressTimestamp(bookId, saved.updated_at, scope);
    } catch (error) {
      notifyReaderContentConflict(bookId, error, scope);
      throw error;
    }
  } else {
    await getRequiredBook(bookId);
    assertAccountScope(scope);
    storeSaveReadingProgress(bookId, progress);
  }

  // A page may already be mounted by the time an exit/keepalive save finishes.
  // Expire both overview modes before notifying it to avoid reusing old counts.
  assertAccountScope(scope);
  invalidateBookListCache();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(READING_PROGRESS_SAVED_EVENT));
}

export function getReaderModeForBook(book: Book): 'manga' | 'novel' {
  return book.readerType === 'comic' || book.readerType === 'image' ? 'manga' : 'novel';
}

export function getSteppedProgressPercent(currentProgressPercent: number, deltaPercent: number): number {
  return Math.min(100, Math.max(0, currentProgressPercent + deltaPercent));
}

async function getRequiredBook(bookId: string): Promise<Book> {
  const book = await getBookById(bookId);

  if (!book) {
    throw new Error(`未找到图书：${bookId}`);
  }

  return book;
}

function createLocalReaderResource(book: Book): ReaderResource {
  if (book.readerType === 'unsupported') {
    return {
      chapterCount: 0,
      readerType: book.readerType,
      toc: [],
    };
  }

  if (book.readerType === 'comic' || book.readerType === 'image') {
    return {
      pageCount: 32,
      pages: Array.from({ length: 32 }, (_, index) => ({
        index: index + 1,
      })),
      readerType: book.readerType,
    };
  }


  if (book.readerType === 'pdf') {
    return {
      fileUrl: undefined,
      readerType: book.readerType,
    };
  }
  return {
    chapterCount: 36,
    readerType: book.readerType,
    toc: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, title: `第${index + 1}章 / 柔光片段` })),
  };
}

function mapBackendReaderResource(resource: BackendReaderResource): ReaderResource {
  if (resource.reader_type === 'comic' || resource.reader_type === 'image') {
    return {
      pageCount: resource.page_count ?? resource.pages.length,
      pages: resource.pages.map((page) => ({ imageUrl: buildApiResourceUrl(page.image_url), index: page.index, positionKey: page.position_key ?? undefined })),
      readerType: resource.reader_type,
      version: resource.version ?? undefined,
    };
  }

  if (resource.reader_type === 'pdf') {
    return {
      fileUrl: buildApiResourceUrl(resource.file_url),
      positionKey: resource.position_key ?? undefined,
      readerType: resource.reader_type,
      version: resource.version ?? undefined,
    };
  }

  if (resource.reader_type === 'unsupported') {
    return {
      chapterCount: 0,
      readerType: resource.reader_type,
      version: resource.version ?? undefined,
      toc: [],
    };
  }

  return {
    chapterCount: resource.chapter_count ?? resource.page_count ?? 0,
    readerType: resource.reader_type,
    version: resource.version ?? undefined,
    toc: resource.toc.map((item) => ({
      contentVersion: item.content_version ?? undefined,
      positionKey: item.position_key ?? undefined,
      index: item.index,
      level: typeof item.level === 'number' ? Math.min(6, Math.max(1, Math.floor(item.level))) : 1,
      progressWeight: typeof item.progress_weight === 'number' && item.progress_weight > 0 ? item.progress_weight : undefined,
      sectionLevel: typeof item.section_level === 'number' ? Math.min(6, Math.max(1, Math.floor(item.section_level))) : 1,
      sectionTitle: item.section_title?.trim() || undefined,
      title: item.title,
    })),
  };
}
