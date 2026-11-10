import { readerContentConflictEvent } from './readerContentConflict';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeReaderMarkStore } from './readerMarkStore';
import { createReaderMark, deleteReaderMark, getReaderMarks, relocateReaderMark, updateReaderMark } from './readerMarkService';

describe('readerMarkService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'false');
    writeReaderMarkStore({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    writeReaderMarkStore({});
    globalThis.fetch = originalFetch;
  });

  it('creates, lists, updates, and deletes local fallback reader marks', async () => {
    const createdMark = await createReaderMark('b1', {
      chapterIndex: 4,
      epubCfi: 'ratio:0.25',
      kind: 'note',
      label: 'Chapter 4',
      note: 'come back here',
      progressPercent: 15,
      readerType: 'epub',
    });

    await expect(getReaderMarks('b1')).resolves.toMatchObject([
      {
        chapterIndex: 4,
        epubCfi: 'ratio:0.25',
        id: createdMark.id,
        kind: 'note',
        note: 'come back here',
      },
    ]);

    await updateReaderMark('b1', createdMark.id, { note: 'updated note' });
    await expect(getReaderMarks('b1')).resolves.toMatchObject([{ id: createdMark.id, note: 'updated note' }]);

    await deleteReaderMark('b1', createdMark.id);
    await expect(getReaderMarks('b1')).resolves.toEqual([]);
  });

  it('maps backend reader marks through the service boundary', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            book_id: 'b1',
            chapter_index: 2,
            created_at: '2026-05-22T00:00:00.000Z',
            epub_cfi: 'ratio:0.5',
            id: 'm1',
            image_index: null,
            kind: 'bookmark',
            label: 'Chapter 2',
            note: '',
            page_number: null,
            progress_percent: 6,
            reader_type: 'epub',
            updated_at: '2026-05-22T00:00:00.000Z',
          },
        ]),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );

    await expect(getReaderMarks('b1')).resolves.toEqual([
      {
        bookId: 'b1',
        chapterIndex: 2,
        createdAt: '2026-05-22T00:00:00.000Z',
        epubCfi: 'ratio:0.5',
        id: 'm1',
        imageIndex: undefined,
        kind: 'bookmark',
        label: 'Chapter 2',
        note: '',
        pageNumber: undefined,
        progressPercent: 6,
        readerType: 'epub',
        updatedAt: '2026-05-22T00:00:00.000Z',
      },
    ]);
  });

  it('passes a cancellation signal to backend reader mark requests', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('[]', { headers: { 'Content-Type': 'application/json' }, status: 200 }),
    );
    globalThis.fetch = fetchMock;

    await expect(getReaderMarks('b1', controller.signal)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/books/b1/marks',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('sends the chapter identity with a backend note so a delayed save can be validated', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'mark', book_id: 'b1', chapter_index: 2, reader_type: 'epub', kind: 'note', note: 'draft', label: 'Chapter',
      progress_percent: 20, created_at: '2026-10-27T01:00:00Z', updated_at: '2026-10-27T01:00:00Z',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = fetchMock;
    await createReaderMark('b1', { chapterIndex: 2, positionKey: 'asset-b', kind: 'note', note: 'draft', label: 'Chapter', progressPercent: 20, readerType: 'epub' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ position_key: 'asset-b', chapter_index: 2 });
  });
  it('notifies the current reader when its save is rejected as a content conflict', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const target = new EventTarget(); const listener = vi.fn();
    vi.stubGlobal('window', target);
    target.addEventListener(readerContentConflictEvent('b1'), listener);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'changed' }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(createReaderMark('b1', { chapterIndex: 2, positionKey: 'a', kind: 'note', note: 'draft', label: 'Chapter', progressPercent: 20, readerType: 'epub' })).rejects.toMatchObject({ status: 409 });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('moves a local note across formats without changing its content or identity', async () => {
    const original = await createReaderMark('b1', { readerType: 'epub', kind: 'note', label: '手动标题', note: '完整备注', chapterIndex: 4, epubCfi: 'aisu-scroll:0.4', progressPercent: 20 });
    const moved = await relocateReaderMark('b1', original.id, { readerType: 'pdf', positionKey: 'pdf:new', pageNumber: 7, progressPercent: 30 });
    expect(moved).toMatchObject({ id: original.id, createdAt: original.createdAt, note: original.note, label: original.label, kind: 'note', readerType: 'pdf', positionKey: 'pdf:new', positionValid: true, pageNumber: 7 });
    expect(moved.chapterIndex).toBeUndefined(); expect(moved.epubCfi).toBeUndefined();
    expect(await getReaderMarks('b1')).toEqual([moved]);
  });
  it('sends only current coordinates when relocating and maps a retained invalid note', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const original = { id: 'm1', book_id: 'b1', reader_type: 'epub', kind: 'note', note: '保留内容', label: '旧标题', chapter_index: 2, progress_percent: 25, position_key: 'old', position_valid: false, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([original])).mockResolvedValueOnce(Response.json({ ...original, position_key: 'new', position_valid: true, chapter_index: 3 }));
    globalThis.fetch = fetchMock;
    expect(await getReaderMarks('b1')).toMatchObject([{ positionKey: 'old', positionValid: false, note: '保留内容' }]);
    const signal = new AbortController().signal;
    const result = await relocateReaderMark('b1', 'm1', { readerType: 'epub', positionKey: 'new', chapterIndex: 3, progressPercent: 40 }, signal);
    expect(result).toMatchObject({ id: 'm1', positionKey: 'new', positionValid: true, note: '保留内容', label: '旧标题' });
    expect(fetchMock.mock.calls[1]).toEqual(['/api/v1/books/b1/marks/m1/position', expect.objectContaining({ method: 'PUT', signal })]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ reader_type: 'epub', position_key: 'new', chapter_index: 3, page_number: null, image_index: null, epub_cfi: null, progress_percent: 40 });
  });
  it('rejects relocation without a current identity before making a request', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn(); globalThis.fetch = fetchMock;
    await expect(relocateReaderMark('b1', 'm1', { readerType: 'epub', chapterIndex: 2, progressPercent: 20 })).rejects.toThrow('当前正文尚未就绪');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
