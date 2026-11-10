import { readerContentConflictEvent } from './readerContentConflict';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBookById } from '../../books';
import { getChapterAudiobookTimeline, getReaderChapter, getReaderModeForBook, getReaderResource, getReadingProgress, getSteppedProgressPercent, mapBackendReaderChapterBlocks, prepareChapterAudiobook, saveReadingProgress } from './readerService';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readerService', () => {
  it('preserves PDF and image position identities through the API mapper', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ reader_type: 'pdf', position_key: 'pdf:key', file_url: '/preview?position_key=pdf:key', pages: [], toc: [] })).mockResolvedValueOnce(Response.json({ reader_type: 'comic', page_count: 1, pages: [{ index: 1, position_key: 'page-key', image_url: '/pages/1?position_key=page-key' }], toc: [] })));
    try {
      await expect(getReaderResource('mapped-pdf')).resolves.toMatchObject({ positionKey: 'pdf:key', fileUrl: expect.stringContaining('position_key=pdf:key') });
      await expect(getReaderResource('mapped-comic')).resolves.toMatchObject({ pages: [{ positionKey: 'page-key', imageUrl: expect.stringContaining('position_key=page-key') }] });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['pdf', 'comic', 'unsupported'] as const)('retains the published %s resource version when refreshing formats', async (readerType) => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ reader_type: readerType, version: '2026-10-27T08:00:00Z', pages: [], toc: [], page_count: 0, file_url: '/book.pdf' })));
    try { await expect(getReaderResource(`version-${readerType}`)).resolves.toMatchObject({ readerType, version: '2026-10-27T08:00:00Z' }); }
    finally { vi.unstubAllEnvs(); }
  });
  it('returns comic resources for manga books', async () => {
    const resource = await getReaderResource('b3');

    expect(resource.readerType).toBe('comic');
    expect('pageCount' in resource ? resource.pageCount : 0).toBe(32);
    expect('pages' in resource ? resource.pages[0]?.imageUrl : undefined).toBeUndefined();
  });

  it('returns toc resources for novel books', async () => {
    const resource = await getReaderResource('b1');

    expect(resource.readerType).toBe('epub');
    expect('toc' in resource ? resource.toc.length : 0).toBeGreaterThan(0);
  });

  it('returns local fallback chapter content through the chapter service boundary', async () => {
    const chapter = await getReaderChapter('b1', 3);

    expect(chapter.index).toBe(3);
    expect(chapter.title).toContain('第 3 章');
    expect(chapter.content).toContain('窗外的风');
  });

  it('chooses reader mode from book reader type', async () => {
    const mangaBook = await getBookById('b3');
    const novelBook = await getBookById('b1');

    expect(mangaBook ? getReaderModeForBook(mangaBook) : '').toBe('manga');
    expect(novelBook ? getReaderModeForBook(novelBook) : '').toBe('novel');
  });

  it('persists local fallback reading progress through the reader service boundary', async () => {
    await saveReadingProgress('b1', {
      bookId: 'b1',
      chapterIndex: 18,
      progressPercent: 73,
      updatedAt: '2026-05-20T00:00:00.000Z',
    });

    await expect(getReadingProgress('b1')).resolves.toMatchObject({
      bookId: 'b1',
      chapterIndex: 18,
      progressPercent: 73,
    });
  });

  it('passes cancellation signals to backend reader resource and progress requests', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        chapter_count: 0,
        cover_url: null,
        file_url: null,
        page_count: 0,
        pages: [],
        reader_type: 'comic',
        toc: [],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        book_id: 'book-1',
        chapter_href: null,
        chapter_index: null,
        epub_cfi: null,
        image_index: 1,
        page_number: null,
        progress_percent: 4,
        reader_type: 'comic',
        updated_at: '2026-07-10T02:00:00Z',
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getReaderResource('book-1', controller.signal)).resolves.toMatchObject({ readerType: 'comic' });
    await expect(getReadingProgress('book-1', controller.signal)).resolves.toMatchObject({ progressPercent: 4 });

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
  });

  it('rejects reading progress when book id does not match', async () => {
    await expect(
      saveReadingProgress('b1', {
        bookId: 'b2',
        progressPercent: 30,
        updatedAt: '2026-05-20T00:00:00.000Z',
      }),
    ).rejects.toThrow('阅读进度保存失败');
  });

  it('clamps stepped reading progress to valid percent range', () => {
    expect(getSteppedProgressPercent(98, 5)).toBe(100);
    expect(getSteppedProgressPercent(2, -5)).toBe(0);
    expect(getSteppedProgressPercent(40, 5)).toBe(45);
  });

  it('maps a signed audiobook ticket without exposing provider credentials', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      audio_url: '/api/v1/files/books/book-1/audiobooks/3?ticket=signed-ticket',
      cached: true,
      chapter_index: 3,
      timeline_url: '/api/v1/files/books/book-1/audiobooks/3/timeline?ticket=signed-ticket',
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(prepareChapterAudiobook('book-1', 3, controller.signal)).resolves.toEqual({
      audioUrl: '/api/v1/files/books/book-1/audiobooks/3?ticket=signed-ticket',
      cached: true,
      chapterIndex: 3,
      timelineUrl: '/api/v1/files/books/book-1/audiobooks/3/timeline?ticket=signed-ticket',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/books/book-1/reader/chapters/3/audiobook',
      expect.objectContaining({ method: 'POST', signal: controller.signal }),
    );
  });

  it('maps valid audiobook timeline cues from the signed endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      cues: [
        { end_seconds: 2.5, paragraph_index: 0, start_seconds: 0 },
        { end_seconds: 2, paragraph_index: 9, start_seconds: 3 },
      ],
      duration_seconds: 2.5,
      ready: true,
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getChapterAudiobookTimeline('/timeline?signed=1')).resolves.toEqual({
      cues: [{ endSeconds: 2.5, paragraphIndex: 0, startSeconds: 0 }],
      durationSeconds: 2.5,
      ready: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/timeline?signed=1', { cache: 'no-store', signal: undefined });
  });
  it('sends chapter identity with queued reading progress', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await saveReadingProgress('book-1', { bookId: 'book-1', chapterIndex: 2, positionKey: 'asset-b', contentVersion: 'revision-b', readerType: 'epub', progressPercent: 20, updatedAt: '2026-10-27T01:00:00Z' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ position_key: 'asset-b', content_version: 'revision-b', chapter_index: 2 });
  });
  it('notifies the current reader when its save is rejected as a content conflict', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const target = new EventTarget(); const listener = vi.fn();
    vi.stubGlobal('window', target);
    target.addEventListener(readerContentConflictEvent('b1'), listener);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'changed' }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(saveReadingProgress('b1', { bookId: 'b1', chapterIndex: 2, positionKey: 'a', readerType: 'epub', progressPercent: 20, updatedAt: '2026-10-27T01:00:00Z' })).rejects.toMatchObject({ status: 409 });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('mapBackendReaderChapterBlocks', () => {
  it('maps headings, ruby, whitelisted marks and images, dropping empties', () => {
    const rawBlocks = [
      { alt: null, image_url: null, level: 2, spans: null, text: '序幕', type: 'heading' },
      {
        level: null,
        spans: [
          { marks: [], ruby: 'かんじ', text: '漢字' },
          { marks: ['strong', 'bogus'], ruby: null, text: '重点' },
        ],
        text: '漢字重点',
        type: 'paragraph',
      },
      { alt: '插图', image_height: 1605, image_url: '/api/v1/files/books/b/chapter-images/1', image_width: 2048, text: null, type: 'image' },
      { level: null, spans: null, text: '   ', type: 'paragraph' },
    ] as unknown as Parameters<typeof mapBackendReaderChapterBlocks>[0];

    const blocks = mapBackendReaderChapterBlocks(rawBlocks) ?? [];

    expect(blocks).toHaveLength(3); // the whitespace-only paragraph is dropped

    const heading = blocks[0];
    expect(heading.type).toBe('heading');
    if (heading.type === 'heading') {
      expect(heading.level).toBe(2);
      expect(heading.text).toBe('序幕');
    }

    const paragraph = blocks[1];
    if (paragraph.type === 'paragraph') {
      expect(paragraph.spans?.[0]).toMatchObject({ ruby: 'かんじ', text: '漢字' });
      expect(paragraph.spans?.[0].marks).toBeUndefined();
      // The unknown "bogus" mark is filtered out; only whitelisted marks survive.
      expect(paragraph.spans?.[1]).toMatchObject({ marks: ['strong'], text: '重点' });
      expect(paragraph.spans?.[1].ruby).toBeUndefined();
    }

    const image = blocks[2];
    if (image.type === 'image') {
      expect(image.alt).toBe('插图');
      expect(image.imageHeight).toBe(1605);
      expect(image.imageUrl).toContain('/api/v1/files/books/b/chapter-images/1');
      expect(image.imageWidth).toBe(2048);
    }
  });

  it('returns undefined when there are no blocks', () => {
    expect(mapBackendReaderChapterBlocks(undefined)).toBeUndefined();
    expect(mapBackendReaderChapterBlocks([])).toBeUndefined();
  });

  it('clamps out-of-range heading levels to a safe default', () => {
    const blocks = mapBackendReaderChapterBlocks([{ level: 99, text: '标题', type: 'heading' }] as unknown as Parameters<typeof mapBackendReaderChapterBlocks>[0]) ?? [];
    const heading = blocks[0];
    expect(heading.type === 'heading' && heading.level).toBe(2);
  });
});
