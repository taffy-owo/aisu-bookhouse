import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, getAccessToken, setAccessToken, setStoredSession } from '../../../shared/api';
import {
  UPLOAD_TASKS_CHANGED_EVENT,
  createLocalUploadTasks,
  createQueuedUploadTasks,
  getUploadFileTypeLabel,
  getUploadStatusMeta,
  getUploadTaskMessage,
  getUploadTasks,
  isSupportedUploadFile,
  replaceBookFile,
  reprocessUploadedBook,
  uploadBookFile,
  uploadBookFiles,
} from './uploadService';

afterEach(() => {
  clearAuthStorage();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('uploadService', () => {
  it('does not open an xhr connection for an already cancelled upload', async () => {
    const xhr = vi.fn();
    vi.stubGlobal('XMLHttpRequest', xhr);
    await expect(uploadBookFile(new File(['book'], 'book.epub'), {
      onProgress: vi.fn(), signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr).not.toHaveBeenCalled();
  });

  it.each([200, 401])('rejects an old account upload response (%s) without retrying under the new account', async (status) => {
    setAccessToken('token-a');
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    const sent = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    class FakeXMLHttpRequest {
      onload: (() => void) | null = null;
      status = status;
      responseText = JSON.stringify({ task_id: 'old-task' });
      upload = { onload: null, onprogress: null };
      open() {}
      setRequestHeader() {}
      send() {
        sent();
        setAccessToken('token-b');
        setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    await expect(uploadBookFile(new File(['private'], 'book.epub'), { onProgress: vi.fn() }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('token-b');
  });

  it('returns local fallback upload tasks', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'false');

    const tasks = await getUploadTasks();

    expect(tasks).toHaveLength(4);
    expect(tasks.map((task) => task.status)).toContain('processing');
  });

  it('maps upload status to display metadata', () => {
    expect(getUploadStatusMeta('ready')).toMatchObject({ description: '已加入书架，可在详情页查看阅读入口。', label: '已完成', tone: 'success' });
    expect(getUploadStatusMeta('failed')).toMatchObject({ description: '上传或解析失败，可查看失败原因。', label: '失败', tone: 'danger' });
    expect(getUploadStatusMeta('queued')).toMatchObject({ description: '等待上传任务开始。', label: '等待中', tone: 'accent' });
  });

  it('maps backend upload error codes to user-facing task messages', () => {
    expect(getUploadTaskMessage({ errorCode: 'processing_failed', message: undefined, status: 'failed' })).toBe('文件处理失败，请检查文件内容后重试。');
    expect(getUploadTaskMessage({ errorCode: 'unknown_error', message: undefined, status: 'failed' })).toBe('上传任务失败，请重新上传或检查文件内容。');
    expect(getUploadTaskMessage({ errorCode: 'processing_failed', message: '文件处理失败：压缩包为空', status: 'failed' })).toBe('文件处理失败：压缩包为空');
  });

  it('maps backend task error codes before rendering upload queues', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([
        {
          book_id: 'book-1',
          error_code: 'processing_failed',
          file_name: 'bad.zip',
          file_size: 2048,
          file_type: 'ZIP',
          id: 'task-1',
          message: null,
          progress: 0,
          status: 'failed',
        },
      ]), { headers: { 'Content-Type': 'application/json' }, status: 200 })),
    );

    const [task] = await getUploadTasks();

    expect(task).toMatchObject({
      errorCode: 'processing_failed',
      message: '文件处理失败，请检查文件内容后重试。',
      status: 'failed',
    });
  });

  it('detects upload file type labels from extensions', () => {
    expect(getUploadFileTypeLabel('星光告白.epub')).toBe('EPUB');
    expect(getUploadFileTypeLabel('漫画第1话.zip')).toBe('ZIP 图片包');
    expect(getUploadFileTypeLabel('封面.jpeg')).toBe('JPG');
    expect(getUploadFileTypeLabel('扫描页.gif')).toBe('GIF');
    expect(getUploadFileTypeLabel('旧电子书.mobi')).toBe('MOBI');
    expect(getUploadFileTypeLabel('压缩漫画.rar')).toBe('未知格式');
    expect(getUploadFileTypeLabel('unknown.exe')).toBe('未知格式');
  });

  it('creates local upload tasks from selected files', () => {
    const tasks = createLocalUploadTasks([
      { name: '新书.epub', size: 1024 },
      { name: '奇怪文件.exe', size: 2048 },
    ]);

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      fileType: 'EPUB',
      progress: 8,
      status: 'uploading',
    });
    expect(tasks[1]).toMatchObject({
      fileType: '未知格式',
      progress: 0,
      status: 'failed',
    });
  });

  it('creates a supported local upload task for MOBI files', () => {
    const [task] = createLocalUploadTasks([{ name: '旧电子书.mobi', size: 4096 }]);

    expect(task).toMatchObject({
      fileType: 'MOBI',
      progress: 8,
      status: 'uploading',
    });
  });

  it('checks whether a selected upload file is supported', () => {
    expect(isSupportedUploadFile({ name: '新书.epub', size: 1024 })).toBe(true);
    expect(isSupportedUploadFile({ name: '压缩漫画.rar', size: 1024 })).toBe(false);
  });

  it('creates queued upload tasks before backend processing starts', () => {
    const tasks = createQueuedUploadTasks([{ name: '新书.epub', size: 1024 }]);

    expect(tasks[0]).toMatchObject({
      message: '等待开始上传',
      progress: 0,
      status: 'queued',
    });
  });

  it('starts every selected backend upload at once instead of serializing the batch', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const files = [
      new File(['book-1'], 'book-1.epub'),
      new File(['book-2'], 'book-2.epub'),
      new File(['book-3'], 'book-3.epub'),
      new File(['book-4'], 'book-4.epub'),
    ];
    const startedFiles: string[] = [];
    let inFlightUploads = 0;
    let maxInFlightUploads = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/uploads/tasks')) {
          return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' }, status: 200 });
        }

        if (url.endsWith('/uploads/books')) {
          const formData = init?.body as FormData;
          const uploadedFile = formData.get('file') as File;
          startedFiles.push(uploadedFile.name);
          inFlightUploads += 1;
          maxInFlightUploads = Math.max(maxInFlightUploads, inFlightUploads);
          await new Promise((resolve) => setTimeout(resolve, 0));
          inFlightUploads -= 1;

          return new Response(JSON.stringify({ book_id: uploadedFile.name, status: 'processing', task_id: uploadedFile.name }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          });
        }

        return new Response('{}', { headers: { 'Content-Type': 'application/json' }, status: 404 });
      }),
    );

    await uploadBookFiles(files);

    expect(startedFiles).toEqual(['book-1.epub', 'book-2.epub', 'book-3.epub', 'book-4.epub']);
    expect(maxInFlightUploads).toBe(4);
  });

  it('rejects a zero-byte file before opening an upload connection', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const xhrSpy = vi.fn();
    vi.stubGlobal('XMLHttpRequest', xhrSpy);

    await expect(uploadBookFile(new File([], 'unfinished.epub'), { onProgress: () => undefined })).rejects.toThrow('文件大小为 0 B');

    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it('sends per-file metadata for manually created text uploads', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const receivedMetadata: Record<string, FormDataEntryValue | null> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/uploads/tasks')) {
          return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' }, status: 200 });
        }
        if (url.endsWith('/uploads/books')) {
          const formData = init?.body as FormData;
          receivedMetadata.title = formData.get('title');
          receivedMetadata.author = formData.get('author');
          receivedMetadata.description = formData.get('description');
          receivedMetadata.publicationStatus = formData.get('publication_status');
          receivedMetadata.sourceUrl = formData.get('source_url');
          receivedMetadata.tags = formData.get('tags');
          return new Response(JSON.stringify({ book_id: 'manual-book', status: 'processing', task_id: 'manual-task' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );

    await uploadBookFiles([new File(['正文'], '手动文章.txt')], {
      metadata: [{
        author: '作者',
        description: '简介',
        publicationStatus: 'ongoing',
        sourceUrl: 'https://kakuyomu.jp/works/1',
        tags: ['短篇', '翻译'],
        title: '作品名',
      }],
    });

    expect(receivedMetadata).toEqual({
      author: '作者',
      description: '简介',
      publicationStatus: 'ongoing',
      sourceUrl: 'https://kakuyomu.jp/works/1',
      tags: '短篇,翻译',
      title: '作品名',
    });
  });

  it('does not send unsupported selected files to the backend', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const startedFiles: string[] = [];
    const failedFiles: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/uploads/tasks')) {
          return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' }, status: 200 });
        }

        if (url.endsWith('/uploads/books')) {
          const formData = init?.body as FormData;
          const uploadedFile = formData.get('file') as File;
          startedFiles.push(uploadedFile.name);

          return new Response(JSON.stringify({ book_id: uploadedFile.name, status: 'processing', task_id: uploadedFile.name }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          });
        }

        return new Response('{}', { headers: { 'Content-Type': 'application/json' }, status: 404 });
      }),
    );

    await uploadBookFiles([new File(['book'], 'book.epub'), new File(['archive'], 'archive.rar')], {
      onFileError: (file) => failedFiles.push(file.name),
    });

    expect(startedFiles).toEqual(['book.epub']);
    expect(failedFiles).toEqual(['archive.rar']);
  });

  it('reports xhr upload progress before backend processing finishes', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const progressValues: number[] = [];

    class FakeXMLHttpRequest {
      onabort: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      responseText = JSON.stringify({ book_id: 'book-1', status: 'processing', task_id: 'task-1' });
      status = 200;
      statusText = 'OK';
      upload: {
        onload: (() => void) | null;
        onprogress: ((event: ProgressEvent) => void) | null;
      } = { onload: null, onprogress: null };

      open() {}

      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
        this.upload.onload?.();
        this.onload?.();
      }

      setRequestHeader() {}
    }

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

    await uploadBookFile(new File(['comic'], 'comic.cbz'), {
      onProcessing: () => progressValues.push(72),
      onProgress: (progress) => progressValues.push(progress),
    });

    expect(progressValues).toEqual([34, 72, 72]);
  });

  it('replaces the selected book and sends the progress preference', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    let requestUrl = '';
    let sentFileName = '';
    let sentKeepProgress: FormDataEntryValue | null = null;

    class FakeXMLHttpRequest {
      onabort: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      responseText = JSON.stringify({ book_id: 'book/1', status: 'processing', task_id: 'replace-task' });
      status = 200;
      statusText = 'OK';
      upload = { onload: null as (() => void) | null, onprogress: null as ((event: ProgressEvent) => void) | null };

      open(_method: string, url: string) {
        requestUrl = url;
      }

      send(body: FormData) {
        sentKeepProgress = body.get('keep_progress');
        sentFileName = (body.get('file') as File).name;
        this.onload?.();
      }

      setRequestHeader() {}
    }

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

    await expect(replaceBookFile('book/1', new File(['better translation'], 'better.epub'), { keepProgress: false })).resolves.toMatchObject({ task_id: 'replace-task' });

    expect(requestUrl).toContain('/uploads/books/book%2F1/replace');
    expect(sentKeepProgress).toBe('false');
    expect(sentFileName).toBe('better.epub');
  });

  it('maps xhr backend upload error codes to readable messages', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');

    class FakeXMLHttpRequest {
      onabort: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      responseText = JSON.stringify({ detail: { error_code: 'file_too_large', task_id: 'task-1' } });
      status = 413;
      statusText = 'Payload Too Large';
      upload: {
        onload: (() => void) | null;
        onprogress: ((event: ProgressEvent) => void) | null;
      } = { onload: null, onprogress: null };

      open() {}

      send() {
        this.onload?.();
      }

      setRequestHeader() {}
    }

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

    await expect(uploadBookFile(new File(['large'], 'large.epub'), { onProgress: () => undefined })).rejects.toMatchObject({
      message: '文件超过上传限制，请压缩后再上传。',
      status: 413,
    });
  });

  it('refreshes an expired session and retries an xhr upload once', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    setAccessToken('expired-token');
    const requests: FakeXMLHttpRequest[] = [];

    class FakeXMLHttpRequest {
      headers = new Map<string, string>();
      onabort: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      responseText = '';
      status = 0;
      statusText = '';
      upload = { onload: null as (() => void) | null, onprogress: null as ((event: ProgressEvent) => void) | null };
      withCredentials = false;

      constructor() {
        requests.push(this);
      }

      open() {}

      send() {
        const isRetry = requests.length === 2;
        this.status = isRetry ? 200 : 401;
        this.statusText = isRetry ? 'OK' : 'Unauthorized';
        this.responseText = JSON.stringify(isRetry
          ? { book_id: 'book-1', status: 'processing', task_id: 'task-1' }
          : { detail: 'expired' });
        this.onload?.();
      }

      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
    }

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'fresh-token' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })));

    await expect(uploadBookFile(new File(['book'], 'book.epub'), { onProgress: () => undefined })).resolves.toMatchObject({ task_id: 'task-1' });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.withCredentials)).toBe(true);
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer expired-token');
    expect(requests[1]?.headers.get('Authorization')).toBe('Bearer fresh-token');
    expect(getAccessToken()).toBe('fresh-token');
  });
});


describe('accepted upload notifications', () => {
  it.each(['ready', 'queued', 'processing', 'failed'] as const)('returns the acknowledged %s state before task refresh', async (status) => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const response = { book_id: status === 'queued' ? null : 'stored-book', task_id: 'receipt-task', status };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    vi.stubGlobal('fetch', fetchMock);
    const accepted = vi.fn(), completed = vi.fn();
    const tasks = await uploadBookFiles([new File(['body'], 'article.txt')], {
      onFileAccepted: accepted, onFileComplete: completed,
    });
    // No progress callback: exercise the fetch transport without an XHR fake.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/uploads\/books$/);
    expect(tasks).toMatchObject([{ id: 'receipt-task', bookId: response.book_id ?? undefined, fileName: 'article.txt', status }]);
    expect(accepted).toHaveBeenCalledWith(expect.any(File), 0, response);
    expect(completed).toHaveBeenCalledTimes(status === 'ready' ? 1 : 0);
  });

  it('keeps accepted files in source order when a partial batch finishes out of order', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, options?: RequestInit) => new Promise<Response>(resolve => {
      pending.set(((options?.body as FormData).get('file') as File).name, resolve);
    })));
    const accepted = vi.fn(), failed = vi.fn();
    const files = ['first.txt', 'unsupported.exe', 'failed.epub', 'last.txt'].map(name => new File(['text'], name));
    const result = uploadBookFiles(files, { onFileAccepted: accepted, onFileError: failed });
    await vi.waitFor(() => expect(pending.size).toBe(3));
    pending.get('last.txt')?.(Response.json({ book_id: 'last-book', task_id: 'last-task', status: 'processing' }));
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
    pending.get('failed.epub')?.(Response.json({ detail: 'Rejected file' }, { status: 422 }));
    pending.get('first.txt')?.(Response.json({ book_id: 'first-book', task_id: 'first-task', status: 'ready' }));
    expect((await result).map(task => task.fileName)).toEqual(['first.txt', 'last.txt']);
    expect(accepted.mock.calls.map(call => call[1])).toEqual([3, 0]);
    expect(failed.mock.calls.map(call => call[1])).toEqual([1, 2]);
  });

  it('does not read task history for an empty selection or an unsupported-only batch', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadBookFiles([])).resolves.toEqual([]);
    const failed = vi.fn();
    await expect(uploadBookFiles([new File(['x'], 'unsupported.exe')], { onFileError: failed })).rejects.toThrow('暂不支持所选文件格式');
    expect(failed).toHaveBeenCalledWith(expect.any(File), 0, expect.any(Error));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves an acknowledged upload without depending on a task-list read', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const announced = vi.fn();
    target.addEventListener(UPLOAD_TASKS_CHANGED_EVENT, announced);
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    class AcceptedXhr {
      upload = { onload: null, onprogress: null };
      onload: (() => void) | null = null;
      status = 200;
      responseText = JSON.stringify({ task_id: 'accepted', book_id: 'book-1', status: 'processing' });
      open() {}
      setRequestHeader() {}
      send() { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', AcceptedXhr);
    const result = await uploadBookFiles([new File(['body'], 'book.txt')], { onFileProgress: vi.fn() });
    expect(announced).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: 'accepted', bookId: 'book-1', fileName: 'book.txt', fileSize: 4, fileType: 'TXT', status: 'processing', progress: 76, message: '服务器已接收，等待解析完成' }]);
  });

  it('does not announce an old account transfer completed after switching accounts', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    setStoredSession({ id: 'old-owner', nickname: 'Old', role: 'user' });
    const announced = vi.fn();
    target.addEventListener(UPLOAD_TASKS_CHANGED_EVENT, announced);
    let complete: (() => void) | undefined;
    class DelayedXhr {
      upload = { onload: null, onprogress: null };
      onload: (() => void) | null = null;
      status = 200;
      responseText = JSON.stringify({ task_id: 'old-task', book_id: 'old-book', status: 'ready' });
      open() {}
      setRequestHeader() {}
      send() { complete = () => this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', DelayedXhr);
    const result = uploadBookFiles([new File(['body'], 'old.txt')], { onFileProgress: vi.fn() });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    setStoredSession({ id: 'new-owner', nickname: 'New', role: 'user' });
    complete?.();
    await rejected;
    expect(announced).not.toHaveBeenCalled();
  });

  it.each([422, 500])('does not announce a rejected upload (%s) as an accepted task', async (status) => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const announced = vi.fn();
    target.addEventListener(UPLOAD_TASKS_CHANGED_EVENT, announced);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    class RejectedXhr {
      upload = { onload: null, onprogress: null };
      onload: (() => void) | null = null;
      status = status;
      responseText = JSON.stringify({ detail: 'Rejected file' });
      open() {}
      setRequestHeader() {}
      send() { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', RejectedXhr);
    await expect(uploadBookFiles([new File(['body'], 'bad.txt')], { onFileProgress: vi.fn() }))
      .rejects.toThrow('所有文件上传失败');
    expect(announced).not.toHaveBeenCalled();
  });
});

it('sends a caller-owned upload identity through fetch and xhr', async () => {
  const requestId = 'd5addc1d-e2f8-40e6-b50d-09e35462d076';
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ book_id: 'b', task_id: 't', status: 'processing' }));
  vi.stubGlobal('fetch', fetchMock);
  await uploadBookFile(new File(['text'], 'article.txt'), { requestId });
  expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Idempotency-Key')).toBe(requestId);
  const headers: Record<string, string> = {};
  class Xhr {
    upload = {};
    status = 200;
    responseText = JSON.stringify({ book_id: 'b', task_id: 't', status: 'processing' });
    onload?: () => void;
    open() {}
    setRequestHeader(name: string, value: string) { headers[name] = value; }
    send() { this.onload?.(); }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  await uploadBookFile(new File(['text'], 'article.txt'), { requestId, onProgress: vi.fn() });
  expect(headers['Idempotency-Key']).toBe(requestId);
});

it('keeps each batch receipt attached to the original file index when unsupported files are skipped', async () => {
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  const calls: Array<{ name: string; key: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    if (String(input).endsWith('/uploads/tasks')) return Response.json([]);
    calls.push({ name: (options.body as FormData).get('file') instanceof File ? ((options.body as FormData).get('file') as File).name : '',
      key: new Headers(options.headers).get('Idempotency-Key') });
    return Response.json({ book_id: 'b', task_id: 't', status: 'ready' });
  }));
  await uploadBookFiles([new File(['one'], 'one.txt'), new File(['bad'], 'bad.exe'), new File(['two'], 'two.epub')], {
    requestIds: ['first-receipt', 'unused-receipt', 'last-receipt'], onFileError: vi.fn(),
  });
  expect(calls).toEqual([{ name: 'one.txt', key: 'first-receipt' }, { name: 'two.epub', key: 'last-receipt' }]);
});

it('does not report an acknowledged parsing failure as still processing', async () => {
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  class FailedParseXhr {
    upload = {};
    status = 200;
    responseText = JSON.stringify({ book_id: 'b', task_id: 't', status: 'failed' });
    onload?: () => void;
    open() {}
    setRequestHeader() {}
    send() { this.onload?.(); }
  }
  vi.stubGlobal('XMLHttpRequest', FailedParseXhr);
  const accepted = vi.fn();
  const processing = vi.fn();
  await uploadBookFiles([new File(['body'], 'book.txt')], { requestIds: ['receipt'], onFileAccepted: accepted, onFileProcessing: processing });
  expect(accepted).toHaveBeenCalledWith(expect.any(File), 0, { book_id: 'b', task_id: 't', status: 'failed' });
  expect(processing).not.toHaveBeenCalled();
});

it('reprocesses the same stored book using a caller-owned receipt and returns its task identity', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ book_id: 'stored', task_id: 'retry-task', status: 'processing' }));
  vi.stubGlobal('fetch', fetchMock);
  const signal = new AbortController().signal;
  await expect(reprocessUploadedBook('stored', 'retry-receipt', signal)).resolves.toEqual({ book_id: 'stored', task_id: 'retry-task', status: 'processing' });
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/uploads\/books\/stored\/reprocess$/);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
  expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Idempotency-Key')).toBe('retry-receipt');
});

it('does not resolve a fully cancelled batch as a successful submission', async () => {
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  const result = uploadBookFiles([new File(['draft'], 'article.txt')], { signals: [AbortSignal.abort()], onFileProgress: vi.fn() });
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});
