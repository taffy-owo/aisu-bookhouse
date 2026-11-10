import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setAccessToken, setStoredSession } from '../../../shared/api';
import { waitForUploadTask } from './uploadTaskObservation';

const task = (status: string) => ({ id: 'task/1', book_id: 'book-1', file_name: 'file.txt', file_size: 20,
  file_type: 'TXT', error_code: null, progress: 72, status, message: '服务器确认的状态' });
const response = (status: string) => new Response(JSON.stringify(task(status)), { status: 200 });
afterEach(() => { clearAuthStorage(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('upload task observation', () => {
  beforeEach(() => vi.stubEnv('VITE_USE_BACKEND_API', 'true'));
  it('queries only the accepted task and stops on its terminal status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response('processing')).mockResolvedValueOnce(response('ready'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForUploadTask('task/1', new AbortController().signal, 3, 0)).resolves.toMatchObject({ status: 'ready' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/uploads/tasks/task%2F1'))).toBe(true);
  });

  it('returns processing after timeout rather than implying failure or completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('processing')));
    await expect(waitForUploadTask('task/1', new AbortController().signal, 2, 0)).resolves.toMatchObject({ status: 'processing' });
  });

  it('preserves the server failure message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('failed')));
    await expect(waitForUploadTask('task/1', new AbortController().signal)).resolves.toMatchObject({ status: 'failed', message: '服务器确认的状态' });
  });

  it('stops immediately when a book change cancels the next poll', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => response('processing'));
    vi.stubGlobal('fetch', fetchMock);
    const observation = waitForUploadTask('task/1', controller.signal, 60, 10000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(observation).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a result delivered after the account changes', async () => {
    setAccessToken('account-a'); setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      setAccessToken('account-b'); setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
      return response('ready');
    }));
    await expect(waitForUploadTask('task/1', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

it('bounds missing-task polling without inventing a terminal status', async () => {
  vi.stubEnv('VITE_USE_BACKEND_API', 'false');
  await expect(waitForUploadTask('nonexistent-task', new AbortController().signal, 2, 0))
    .rejects.toThrow('暂时查不到该上传任务');
});
