import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession, ApiError } from '../../../shared/api';
import { acknowledgeAllBookSourceUpdates, acknowledgeBookSourceUpdate, appendBookChapter, checkBookSourceUpdate, deleteBook, getBookById, getBooks, getBookshelfOverview, getEditableBookChapters, getPublicBookList, getRecommendedBooks, getReaderRouteForBook, getSourceUpdateNotifications, invalidateBookListCache, removeCustomBookCover, searchBooks, setBookDisliked, setBookFavorite, sortBooks, updateBook, uploadBookCover } from './bookService';
import { writeProgressStore } from '../../reading-progress';

describe('bookService', () => {
  const originalFetch = globalThis.fetch;

  it('marks a prepared chapter body so the server will not extract its first paragraph again', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ chapter_count: 2, index: 2, text_length: 23, title: '第二章 夜雨' }), { status: 200 }));
    globalThis.fetch = fetchMock;
    const content = '第三章 这是正文里的章节名\n\n后面的正文。';
    await appendBookChapter('book-1', { title: '第二章 夜雨', content, contentIsBody: true });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ title: '第二章 夜雨', content, content_is_body: true });
    await appendBookChapter('book-1', { content: '第二章 夜雨\n\n未整理的正文。' });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).not.toHaveProperty('content_is_body');
  });

  afterEach(() => {
    // Clean up local progress store after tests
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    writeProgressStore({});
    invalidateBookListCache();
    clearAuthStorage();
  });

  it('searches books by title, author, or tag', async () => {
    const books = await searchBooks({ q: '星光' });

    expect(books).toHaveLength(1);
    expect(books[0]?.title).toBe('她与星光的告白');
  });

  it('filters books by kind and tag', async () => {
    const books = await searchBooks({ kind: 'manga', tag: '校园' });

    expect(books.map((book) => book.title)).toEqual(['白昼与烟火']);
  });

  it('sorts books by progress', async () => {
    const books = await searchBooks({ sort: 'progress' });

    expect(books[0]?.progressPercent).toBe(100);
  });

  it('sorts books by public work signals', () => {
    const baseBook = {
      author: '作者',
      createdAt: '2026-01-01T00:00:00.000Z',
      description: '',
      id: 'a',
      kind: 'novel' as const,
      progressPercent: 0,
      readerType: 'epub' as const,
      tags: [],
      title: 'A',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const books = [
      { ...baseBook, id: 'a', chapterCount: 1, characterCount: 100, commentCount: 0 },
      { ...baseBook, id: 'b', chapterCount: 5, characterCount: 50, commentCount: 3 },
    ];

    expect(sortBooks(books, 'comments')[0]?.id).toBe('b');
    expect(sortBooks(books, 'chapters')[0]?.id).toBe('b');
    expect(sortBooks(books, 'words')[0]?.id).toBe('a');
  });

  it('returns public library pagination metadata', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          has_more: true,
          items: [createBackendBook({ id: 'public-1', title: 'Public One' })],
          page: 2,
          page_size: 1,
          total: 3,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );

    const firstPage = await getPublicBookList({ page: 1, pageSize: 1 });

    expect(firstPage.books).toHaveLength(1);
    expect(firstPage.books[0]?.id).toBe('public-1');
    expect(firstPage.page).toBe(2);
    expect(firstPage.pageSize).toBe(1);
    expect(firstPage.total).toBe(3);
    expect(firstPage.hasMore).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/books/public?page=1&page_size=1&sort=recent'), expect.any(Object));
  });

  it('passes cancellation signals to backend book list requests', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          has_more: false,
          items: [],
          page: 1,
          page_size: 24,
          total: 0,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    await getPublicBookList({ signal: controller.signal });
    await searchBooks({ signal: controller.signal });

    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/books/public?'), expect.objectContaining({ signal: controller.signal }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/books?'), expect.objectContaining({ signal: controller.signal }));
  });

  it('finds a book detail by id', async () => {
    const book = await getBookById('b3');

    expect(book?.readerType).toBe('comic');
  });

  it('passes cancellation signals to book detail and editable chapter requests', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(createBackendBook({ id: 'book-1', reader_type: 'comic' })), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ index: 1, title: '第一话' }]), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    globalThis.fetch = fetchMock;

    await expect(getBookById('book-1', controller.signal)).resolves.toMatchObject({ id: 'book-1', readerType: 'comic' });
    await expect(getEditableBookChapters('book-1', controller.signal)).resolves.toEqual([{ index: 1, title: '第一话' }]);

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
  });

  it('caches the private library list and dedupes concurrent full fetches', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn().mockImplementation(async () => createBookListResponse([createBackendBook({ id: 'book-1' })]));
    globalThis.fetch = fetchMock;

    const [firstBooks, secondBooks] = await Promise.all([getBooks(), getBooks()]);
    await getBooks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secondBooks).toBe(firstBooks);
    expect(firstBooks[0]?.id).toBe('book-1');
  });

  it('keeps active reads ahead of unread books and completed reads in recent order', () => {
    const base = {
      author: '作者',
      createdAt: '2026-08-01T00:00:00.000Z',
      description: '',
      kind: 'novel' as const,
      readerType: 'epub' as const,
      tags: [],
    };
    const books = [
      { ...base, id: 'finished', progressPercent: 100, title: '已读完', updatedAt: '2026-08-17T09:00:00.000Z' },
      { ...base, id: 'unread', progressPercent: 0, title: '未读', updatedAt: '2026-08-17T08:30:00.000Z' },
      { ...base, id: 'reading-old', progressPercent: 20, title: '较早在读', updatedAt: '2026-08-17T08:00:00.000Z' },
      { ...base, id: 'reading-new', progressPercent: 40, title: '刚刚读过', updatedAt: '2026-08-17T09:30:00.000Z' },
      { ...base, id: 'reading-zero', progressPercent: 0, lastReadAt: '2026-08-17T09:00:00.000Z', title: '不足百分之一', updatedAt: '2026-08-17T09:00:00.000Z' },
    ];

    expect(sortBooks(books, 'recent').map((book) => book.id)).toEqual(['reading-new', 'reading-zero', 'reading-old', 'unread', 'finished']);
  });

  it('maps and caches the compact bookshelf overview', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const backendBook = createBackendBook({ id: 'book-1', title: 'Book One' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      book_labels: [{ id: 'book-1', title: 'Book One' }],
      continue_book: backendBook,
      favorite_count: 2,
      finished_count: 3,
      in_progress_count: 1,
      ongoing_count: 7,
      source_update_count: 42,
      updated_items: [createBackendBook({ id: 'outside-recent', source_update_count: 42 })],
      items: [backendBook],
      total: 8,
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    globalThis.fetch = fetchMock;

    const [first, second] = await Promise.all([getBookshelfOverview(), getBookshelfOverview()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.total).toBe(8);
    expect(first.ongoingCount).toBe(7);
    expect(first.sourceUpdateCount).toBe(42);
    expect(first.updatedBooks[0]?.id).toBe('outside-recent');
    expect(first.continueBook?.id).toBe('book-1');
    expect(second).toBe(first);
  });

  it('keeps the homepage overview separate from the profile book-label list', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify({
      book_labels: url.includes('include_labels=true') ? [{ id: 'book-1', title: 'Book One' }] : [],
      items: [], total: 1, favorite_count: 0, finished_count: 0, in_progress_count: 0,
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 })));
    globalThis.fetch = fetchMock;

    expect((await getBookshelfOverview(false)).bookLabels).toEqual([]);
    expect((await getBookshelfOverview(true)).bookLabels).toEqual([{ id: 'book-1', title: 'Book One' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets a page cancel its wait without cancelling a shared overview request', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    globalThis.fetch = fetchMock;
    const controller = new AbortController();
    const cancelled = getBookshelfOverview(false, controller.signal);
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    resolveFetch(new Response(JSON.stringify({ items: [], total: 0, favorite_count: 0, finished_count: 0, in_progress_count: 0 }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));
    await expect(getBookshelfOverview(false)).resolves.toMatchObject({ total: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse another account bookshelf cache', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createBookListResponse([createBackendBook({ id: 'private-a' })]))
      .mockResolvedValueOnce(createBookListResponse([createBackendBook({ id: 'private-b' })]));
    globalThis.fetch = fetchMock;
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    expect((await getBooks())[0].id).toBe('private-a');
    setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
    expect((await getBooks())[0].id).toBe('private-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves recommendations from the same cached library fetch', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn().mockImplementation(async () => createBookListResponse([createBackendBook({ favorite: true, id: 'book-1' })]));
    globalThis.fetch = fetchMock;

    await getBooks();
    const recommendedBooks = await getRecommendedBooks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recommendedBooks[0]?.id).toBe('book-1');
  });

  it('expires the private library cache after the TTL', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fetchMock = vi.fn().mockImplementation(async () => createBookListResponse([createBackendBook({ id: 'book-1' })]));
    globalThis.fetch = fetchMock;

    await getBooks();
    nowSpy.mockReturnValue(1_000_000 + 31_000);
    await getBooks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed private library fetch', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockImplementation(async () => createBookListResponse([createBackendBook({ id: 'book-1' })]));
    globalThis.fetch = fetchMock;

    await expect(getBooks()).rejects.toBeInstanceOf(ApiError);

    const books = await getBooks();
    expect(books[0]?.id).toBe('book-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates the private library cache after book mutations', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return createBookListResponse([createBackendBook({ id: 'book-1' })]);
    });
    globalThis.fetch = fetchMock;

    await getBooks();
    await getBooks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await deleteBook('book-1');
    await getBooks();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null from getBookById only for backend 404 responses', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: '图书不存在' }), { headers: { 'Content-Type': 'application/json' }, status: 404 }),
    );

    await expect(getBookById('missing-book')).resolves.toBeNull();
  });

  it('rethrows non-404 backend errors from getBookById', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    // The client retries transient read failures. Return a fresh response for
    // every attempt so cancelling a discarded body cannot make the retry's
    // response unusable.
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('bad gateway', { status: 502 })));

    await expect(getBookById('book-1')).rejects.toMatchObject({ name: 'ApiError', status: 502 });
  });

  it('returns recommended books', async () => {
    const books = await getRecommendedBooks();

    expect(books.length).toBeGreaterThan(0);
    expect(books.some((book) => book.favorite || book.kind === 'manga')).toBe(true);
  });

  it('chooses reader route from reader type', async () => {
    const mangaBook = await getBookById('b3');
    const novelBook = await getBookById('b1');

    expect(mangaBook ? getReaderRouteForBook(mangaBook) : '').toBe('/reader/manga/b3');
    expect(novelBook ? getReaderRouteForBook(novelBook) : '').toBe('/reader/novel/b1');
  });

  it('updates favorite status through the book service boundary', async () => {
    const favoriteBook = await setBookFavorite('b1', true);
    expect(favoriteBook.favorite).toBe(true);

    const unfavoriteBook = await setBookFavorite('b1', false);
    expect(unfavoriteBook.favorite).toBe(false);
  });

  it('deletes local fallback books through the book service boundary', async () => {
    const beforeDelete = await getBookById('b2');
    expect(beforeDelete).not.toBeNull();

    await deleteBook('b2');

    await expect(getBookById('b2')).resolves.toBeNull();
    await expect(deleteBook('b2')).rejects.toThrow('未找到图书：b2');
  });

  it('overlays localStorage progress and sorts by recent reading timestamp', async () => {
    const futureDateStr = new Date(Date.now() + 60000).toISOString();
    writeProgressStore({
      b1: {
        bookId: 'b1',
        chapterIndex: 5,
        progressPercent: 45,
        updatedAt: futureDateStr,
      },
    });

    const book = await getBookById('b1');
    expect(book?.progressPercent).toBe(45);
    expect(book?.currentChapter).toBe('第 5 章');
    expect(book?.updatedAt).toBe(futureDateStr);

    const sortedBooks = await getBooks();
    expect(sortedBooks[0]?.id).toBe('b1');
  });

  it('updates editable book metadata through the book service boundary', async () => {
    const updatedBook = await updateBook('b1', {
      author: '  新作者  ',
      description: '  新简介  ',
      tags: [' 百合 ', '校园', '', '百合'],
      title: '  新书名  ',
    });

    expect(updatedBook).toMatchObject({
      author: '新作者',
      description: '新简介',
      tags: ['百合', '校园'],
      title: '新书名',
    });
  });

  it('updates disliked status through the book service boundary', async () => {
    const dislikedBook = await setBookDisliked('b1', true);
    expect(dislikedBook.disliked).toBe(true);

    const restoredBook = await setBookDisliked('b1', false);
    expect(restoredBook.disliked).toBe(false);
  });

  it('sends source baselines when parsed metadata is saved', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(createBackendBook({ id: 'book-1' })), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    globalThis.fetch = fetchMock;

    await updateBook('book-1', { sourceCharacterCount: 125_428, sourceEpisodeCount: 37, sourceUrl: 'https://kakuyomu.jp/works/1' });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      source_character_count: 125_428,
      source_episode_count: 37,
      source_url: 'https://kakuyomu.jp/works/1',
    });
  });

  it('uploads and removes a custom cover through multipart endpoints', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(createBackendBook({ cover_url: '/api/v1/files/books/book-1/cover?v=1&custom=1', id: 'book-1' })), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createBackendBook({ cover_url: null, id: 'book-1' })), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    globalThis.fetch = fetchMock;
    const file = new File(['cover'], 'cover.png', { type: 'image/png' });

    await expect(uploadBookCover('book-1', file)).resolves.toMatchObject({ id: 'book-1' });
    await expect(removeCustomBookCover('book-1')).resolves.toMatchObject({ coverUrl: undefined });

    const uploadRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(uploadRequest.method).toBe('PUT');
    expect(uploadRequest.body).toBeInstanceOf(FormData);
    expect((uploadRequest.body as FormData).get('file')).toBe(file);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(expect.stringContaining('/books/book-1/cover'));
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('checks and acknowledges source updates through dedicated endpoints', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(createBackendBook({ id: 'book-1', source_update_count: 2 })), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ book_count: 1, episode_count: 2, items: [createBackendBook({ id: 'book-1', source_update_count: 2 })] }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createBackendBook({ id: 'book-1', source_update_count: 0 })), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ book_count: 0, episode_count: 0, items: [] }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    globalThis.fetch = fetchMock;

    await expect(checkBookSourceUpdate('book-1')).resolves.toMatchObject({ sourceUpdateCount: 2 });
    await expect(getSourceUpdateNotifications()).resolves.toMatchObject({ bookCount: 1, episodeCount: 2, items: [{ id: 'book-1' }] });
    await expect(acknowledgeBookSourceUpdate('book-1')).resolves.toMatchObject({ sourceUpdateCount: 0 });
    await expect(acknowledgeAllBookSourceUpdates()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining('/books/book-1/source-update/check'),
      expect.stringContaining('/books/source-updates'),
      expect.stringContaining('/books/book-1/source-update/acknowledge'),
      expect.stringContaining('/books/source-updates/acknowledge'),
    ]));
  });
});

function createBookListResponse(items: unknown[]) {
  return new Response(
    JSON.stringify({
      has_more: false,
      items,
      page: 1,
      page_size: 100,
      total: items.length,
    }),
    { headers: { 'Content-Type': 'application/json' }, status: 200 },
  );
}

function createBackendBook(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    asset_count: 0,
    author: '作者',
    chapter_count: 0,
    character_count: 0,
    comment_count: 0,
    cover_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    current_chapter: null,
    description: '',
    favorite: false,
    disliked: false,
    file_ext: null,
    file_size: null,
    hero_image_url: null,
    id: 'public-1',
    is_owned: false,
    kind: 'novel',
    language: 'und',
    last_content_updated_at: null,
    mime_type: null,
    owner_id: 'owner-1',
    owner_nickname: '分享者',
    page_count: 0,
    progress_percent: 0,
    publication_status: 'ongoing',
    public_approved_at: '2026-01-01T00:00:00.000Z',
    public_download_allowed: true,
    public_rejected_at: null,
    public_requested_at: null,
    public_share_note: null,
    public_source_note: null,
    public_status: 'public',
    rating: 0,
    reader_type: 'epub',
    readers_label: '公共书库',
    series_kind: null,
    series_order: null,
    series_title: null,
    source_url: null,
    source_episode_count: null,
    source_character_count: null,
    source_update_count: 0,
    source_checked_at: null,
    source_check_error: null,
    status: 'ready',
    subtitle: null,
    tags: [],
    title: 'Public One',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}
