import { assertAccountScope, getAccountScope } from '../../../shared/api';
import { getUploadTask } from './uploadService';
import type { UploadTask } from '../types/upload';

/** A polling timeout says only that processing is still unconfirmed. */
export async function waitForUploadTask(taskId: string, signal: AbortSignal, attempts = 60, intervalMs = 1000): Promise<UploadTask> {
  const accountScope = getAccountScope();
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    assertAccountScope(accountScope);
    const task = await getUploadTask(taskId, signal);
    signal.throwIfAborted();
    assertAccountScope(accountScope);
    if (!task) {
      if (attempt >= attempts - 1) throw new Error('暂时查不到该上传任务，请稍后在上传页面查看状态。');
      await delay(intervalMs, signal);
      continue;
    }
    if (task.status === 'ready' || task.status === 'failed' || attempt >= attempts - 1) return task;
    await delay(intervalMs, signal);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
