import { ApiError, apiRequest, assertAccountScope, buildApiUrl, expireApiSession, getAccessToken, getAccountScope, getApiErrorMessage, isBackendApiEnabled, refreshApiSessionStatus } from '../../../shared/api';
import { isAbortError } from '../../../shared/utils/abortError';
import type { UploadFileLike, UploadStatus, UploadStatusMeta, UploadTask } from '../types/upload';
import { invalidateBookListCache } from '../../books/services/bookService';

export const UPLOAD_TASKS_CHANGED_EVENT = 'aisu:upload-tasks-changed';

type BackendUploadTask = {
  book_id: string | null;
  error_code: string | null;
  file_name: string;
  file_size: number;
  file_type: string;
  id: string;
  message: string | null;
  progress: number;
  status: UploadStatus;
};

export type BackendUploadResponse = {
  book_id: string | null;
  status: UploadStatus;
  task_id: string;
};

export type UploadBookMetadata = {
  author?: string;
  description?: string;
  publicationStatus?: 'ongoing' | 'completed';
  sourceUrl?: string;
  tags?: string[];
  title?: string;
};

type UploadBookFilesOptions = {
  requestIds?: (string | undefined)[];
  metadata?: (UploadBookMetadata | undefined)[];
  onFileAccepted?: (file: File, index: number, response: BackendUploadResponse) => void;
  onFileComplete?: (file: File, index: number) => void;
  onFileError?: (file: File, index: number, error: unknown) => void;
  onFileProcessing?: (file: File, index: number) => void;
  onFileProgress?: (file: File, index: number, progress: number) => void;
  onFileStart?: (file: File, index: number) => void;
  signals?: (AbortSignal | undefined)[];
};

export type UploadBookFileOptions = {
  requestId?: string;
  metadata?: UploadBookMetadata;
  onProcessing?: () => void;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
};

export type ReplaceBookFileOptions = Pick<UploadBookFileOptions, 'onProcessing' | 'onProgress' | 'signal'> & {
  keepProgress?: boolean;
};

const EXTENSION_TYPE_LABELS: Record<string, string> = {
  avif: 'AVIF',
  bmp: 'BMP',
  cbz: 'CBZ',
  epub: 'EPUB',
  gif: 'GIF',
  jfif: 'JFIF',
  jpg: 'JPG',
  jpeg: 'JPG',
  mobi: 'MOBI',
  pdf: 'PDF',
  png: 'PNG',
  txt: 'TXT',
  webp: 'WEBP',
  zip: 'ZIP 图片包',
};

const IMAGE_FILE_TYPES = ['AVIF', 'BMP', 'GIF', 'JFIF', 'JPG', 'PNG', 'WEBP'];
const UNKNOWN_UPLOAD_FILE_TYPE_LABEL = '未知格式';

const UPLOAD_ERROR_CODE_MESSAGES: Record<string, string> = {
  file_too_large: '文件超过上传限制，请压缩后再上传。',
  processing_failed: '文件处理失败，请检查文件内容后重试。',
  unsupported_format: '暂不支持该文件格式。',
};

const MOCK_UPLOAD_TASKS: UploadTask[] = [
  {
    bookId: 'local-u1',
    fileName: '樱色日记.epub',
    fileSize: 3480000,
    fileType: 'EPUB',
    id: 'u1',
    message: '已加入书架',
    progress: 100,
    status: 'ready',
  },
  {
    bookId: 'local-u2',
    fileName: '夏日回声 第 3 话.cbz',
    fileSize: 18800000,
    fileType: 'CBZ',
    id: 'u2',
    message: '正在生成漫画页索引',
    progress: 64,
    status: 'processing',
  },
  {
    bookId: 'local-u3',
    fileName: '海边画集.zip',
    fileSize: 9600000,
    fileType: 'ZIP 图片包',
    id: 'u3',
    message: '正在上传到私人空间',
    progress: 38,
    status: 'uploading',
  },
  {
    fileName: '旧版扫描.pdf',
    fileSize: 12500000,
    fileType: 'PDF',
    id: 'u4',
    message: '文件结构无法识别',
    progress: 19,
    status: 'failed',
  },
];

export async function getUploadTasks(signal?: AbortSignal): Promise<UploadTask[]> {
  if (isBackendApiEnabled()) {
    const tasks = await apiRequest<BackendUploadTask[]>('/uploads/tasks', { signal });
    return tasks.map(mapBackendUploadTask);
  }

  return [...MOCK_UPLOAD_TASKS];
}

export async function getUploadTask(taskId: string, signal?: AbortSignal): Promise<UploadTask | null> {
  if (isBackendApiEnabled()) {
    const task = await apiRequest<BackendUploadTask>(`/uploads/tasks/${encodeURIComponent(taskId)}`, { signal });
    return mapBackendUploadTask(task);
  }
  return MOCK_UPLOAD_TASKS.find((task) => task.id === taskId) ?? null;
}

export async function clearCompletedUploadTasks(signal?: AbortSignal): Promise<number> {
  if (!isBackendApiEnabled()) {
    return 0;
  }

  const response = await apiRequest<{ deleted: number }>('/uploads/tasks/completed', {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
  return response.deleted;
}

export async function uploadBookFiles(files: File[], options: UploadBookFilesOptions = {}): Promise<UploadTask[]> {
  const accountScope = getAccountScope();
  if (!isBackendApiEnabled()) {
    return createLocalUploadTasks(files);
  }

  if (files.length === 0) {
    return [];
  }

  const supportedFiles = files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => isSupportedUploadFile(file));
  const unsupportedFiles = files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => !isSupportedUploadFile(file));

  for (const { file, index } of unsupportedFiles) {
    options.onFileError?.(file, index, new Error('暂不支持该文件格式'));
  }

  if (supportedFiles.length === 0) {
    throw new Error('暂不支持所选文件格式');
  }

  let failedCount = 0;
  let acceptedCount = 0;
  const acceptedTasks = new Map<number, UploadTask>();

  await Promise.all(
    supportedFiles.map(async ({ file, index }) => {
      try {
        options.onFileStart?.(file, index);
        const uploadOptions: UploadBookFileOptions = {};
        uploadOptions.requestId = options.requestIds?.[index];
        const metadata = options.metadata?.[index];
        if (metadata) {
          uploadOptions.metadata = metadata;
        }
        const signal = options.signals?.[index];
        if (signal) {
          uploadOptions.signal = signal;
        }
        if (options.onFileProcessing) {
          uploadOptions.onProcessing = () => options.onFileProcessing?.(file, index);
        }
        if (options.onFileProgress) {
          uploadOptions.onProgress = (progress) => options.onFileProgress?.(file, index, progress);
        }
        const response = await uploadBookFile(file, uploadOptions);
        assertAccountScope(accountScope);
        acceptedCount += 1;
        acceptedTasks.set(index, createAcceptedUploadTask(file, response));
        invalidateBookListCache();
        options.onFileAccepted?.(file, index, response);
        if (response.status === 'ready') {
          options.onFileComplete?.(file, index);
        } else if (response.status === 'processing') {
          options.onFileProcessing?.(file, index);
        }
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(UPLOAD_TASKS_CHANGED_EVENT));
      } catch (error) {
        if (!isAbortError(error)) {
          failedCount += 1;
        }
        options.onFileError?.(file, index, error);
      }
    }),
  );

  assertAccountScope(accountScope);
  if (acceptedCount === 0) {
    if (failedCount === 0) throw new DOMException('上传已取消', 'AbortError');
    throw new Error('所有文件上传失败，请检查文件格式或后端状态。');
  }

  // A read failure or a slow task list cannot undo an acknowledged upload.
  // The page observes task updates independently and can retry only that GET.
  return [...acceptedTasks].sort(([a], [b]) => a - b).map(([, task]) => task);
}

export function createAcceptedUploadTask(file: UploadFileLike, response: BackendUploadResponse): UploadTask {
  return {
    id: response.task_id,
    bookId: response.book_id ?? undefined,
    fileName: file.name,
    fileSize: file.size,
    fileType: getUploadFileTypeLabel(file.name),
    status: response.status,
    progress: response.status === 'ready' ? 100 : response.status === 'failed' ? 0 : response.status === 'processing' ? 76 : 8,
    message: response.status === 'ready' ? '已保存并解析完成' : response.status === 'failed' ? '原文件已保存，解析失败，可重试解析' : '服务器已接收，等待解析完成',
  };
}

/** Retry parsing the stored original, keeping one identity until acknowledged. */
export async function reprocessUploadedBook(bookId: string, requestId: string, signal?: AbortSignal): Promise<BackendUploadResponse> {
  const accountScope = getAccountScope();
  const response = await apiRequest<BackendUploadResponse>(`/uploads/books/${encodeURIComponent(bookId)}/reprocess`, {
    method: 'POST', headers: { 'Idempotency-Key': requestId }, signal,
  });
  assertAccountScope(accountScope);
  invalidateBookListCache();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(UPLOAD_TASKS_CHANGED_EVENT));
  return response;
}

export async function uploadBookFile(file: File, options: UploadBookFileOptions = {}): Promise<BackendUploadResponse> {
  const accountScope = getAccountScope();
  await assertReadableUploadFile(file);
  assertAccountScope(accountScope);

  if (options.onProgress || options.onProcessing) {
    return uploadBookFileWithProgress(file, options);
  }

  const formData = new FormData();
  formData.set('file', file);
  appendUploadMetadata(formData, options.metadata);

  return apiRequest<BackendUploadResponse>('/uploads/books', {
    body: formData,
    headers: options.requestId ? { 'Idempotency-Key': options.requestId } : undefined,
    method: 'POST',
    signal: options.signal,
  });
}

export async function replaceBookFile(bookId: string, file: File, options: ReplaceBookFileOptions = {}): Promise<BackendUploadResponse> {
  const accountScope = getAccountScope();
  if (!isBackendApiEnabled()) {
    throw new Error('替换书籍文件需要连接服务器');
  }
  if (!isSupportedUploadFile(file)) {
    throw new Error('暂不支持该文件格式');
  }
  await assertReadableUploadFile(file);
  assertAccountScope(accountScope);

  return uploadBookFileWithProgress(
    file,
    options,
    false,
    `/uploads/books/${encodeURIComponent(bookId)}/replace`,
    (formData) => formData.set('keep_progress', String(options.keepProgress ?? true)),
  );
}

export function createLocalUploadTasks(files: UploadFileLike[]): UploadTask[] {
  return files.map((file, index) => createLocalUploadTask(file, index));
}

export function createQueuedUploadTasks(files: UploadFileLike[]): UploadTask[] {
  return files.map((file, index) => createLocalUploadTask(file, index, 'queued'));
}

export function createLocalUploadTask(file: UploadFileLike, index = 0, status: UploadStatus = 'uploading'): UploadTask {
  const fileType = getUploadFileTypeLabel(file.name);
  const isSupported = fileType !== UNKNOWN_UPLOAD_FILE_TYPE_LABEL;
  const taskId = `local-${Date.now()}-${index}`;
  const safeStatus = isSupported ? status : 'failed';

  return {
    fileName: file.name,
    fileSize: file.size,
    fileType,
    id: taskId,
    message: isSupported ? getLocalUploadMessage(fileType, safeStatus) : '暂不支持该文件格式',
    progress: getLocalUploadProgress(safeStatus),
    status: safeStatus,
  };
}

export function getUploadFileTypeLabel(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase();

  if (!extension) {
    return UNKNOWN_UPLOAD_FILE_TYPE_LABEL;
  }

  return EXTENSION_TYPE_LABELS[extension] ?? UNKNOWN_UPLOAD_FILE_TYPE_LABEL;
}

export function isSupportedUploadFile(file: UploadFileLike): boolean {
  return getUploadFileTypeLabel(file.name) !== UNKNOWN_UPLOAD_FILE_TYPE_LABEL;
}

export function getUploadStatusMeta(status: UploadStatus): UploadStatusMeta {
  const metaMap: Record<UploadStatus, UploadStatusMeta> = {
    failed: { description: '上传或解析失败，可查看失败原因。', label: '失败', tone: 'danger' },
    processing: { description: '服务器正在保存并解析在线阅读资源。', label: '处理中', tone: 'accent' },
    queued: { description: '等待上传任务开始。', label: '等待中', tone: 'accent' },
    ready: { description: '已加入书架，可在详情页查看阅读入口。', label: '已完成', tone: 'success' },
    uploading: { description: '文件正在传到服务器。', label: '上传中', tone: 'accent' },
  };

  return metaMap[status];
}

export function getUploadTaskMessage(task: Pick<UploadTask, 'message' | 'status'> & { errorCode?: string | null }): string {
  if (task.message) {
    return task.message;
  }

  if (task.errorCode) {
    return UPLOAD_ERROR_CODE_MESSAGES[task.errorCode] ?? '上传任务失败，请重新上传或检查文件内容。';
  }

  return getUploadStatusMeta(task.status).description;
}

function uploadBookFileWithProgress(
  file: File,
  options: UploadBookFileOptions,
  hasRetriedAfterRefresh = false,
  endpoint = '/uploads/books',
  appendFormData?: (formData: FormData) => void,
): Promise<BackendUploadResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('上传已取消', 'AbortError'));
      return;
    }
    const accountScope = getAccountScope();
    const xhr = new XMLHttpRequest();
    const tokenAtRequest = getAccessToken();
    const formData = new FormData();
    formData.set('file', file);
    appendUploadMetadata(formData, options.metadata);
    appendFormData?.(formData);

    xhr.open('POST', buildApiUrl(endpoint));
    xhr.withCredentials = true;
    if (options.requestId) xhr.setRequestHeader('Idempotency-Key', options.requestId);

    if (tokenAtRequest) {
      xhr.setRequestHeader('Authorization', `Bearer ${tokenAtRequest}`);
    }

    const abortUpload = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener('abort', abortUpload);
    options.signal?.addEventListener('abort', abortUpload, { once: true });

    xhr.upload.onprogress = (event) => {
      if (getAccountScope() !== accountScope || !event.lengthComputable || event.total <= 0) {
        return;
      }

      const uploadedPercent = event.loaded / event.total;
      options.onProgress?.(Math.max(8, Math.min(68, uploadedPercent * 68)));
    };

    xhr.upload.onload = () => {
      if (getAccountScope() !== accountScope) return;
      options.onProgress?.(72);
      options.onProcessing?.();
    };

    xhr.onload = async () => {
      cleanup();
      try {
        assertAccountScope(accountScope);
        if (xhr.status === 401) {
          if (tokenAtRequest && !hasRetriedAfterRefresh) {
            const currentToken = getAccessToken();
            const refreshStatus = (currentToken !== null && currentToken !== tokenAtRequest)
              ? 'refreshed' : await refreshApiSessionStatus();
            assertAccountScope(accountScope);
            if (refreshStatus === 'refreshed') {
              resolve(uploadBookFileWithProgress(file, options, true, endpoint, appendFormData));
              return;
            }
            if (refreshStatus === 'temporarily-unavailable') {
              reject(new ApiError('登录状态暂时无法确认。若重试仍失败，请先保存未提交内容，再退出并重新登录后重试上传。', 503));
              return;
            }
          }
          expireApiSession();
        }

        const payload = readXhrJson(xhr);
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ApiError(getErrorMessage(payload, xhr.statusText), xhr.status, payload));
          return;
        }

        resolve(payload as BackendUploadResponse);
      } catch (error) {
        reject(error);
      }
    };

    xhr.onerror = () => {
      cleanup();
      reject(new Error(getUploadConnectionErrorMessage()));
    };
    xhr.onabort = () => {
      cleanup();
      const abortError = new Error('上传已取消');
      abortError.name = 'AbortError';
      reject(abortError);
    };
    try {
      xhr.send(formData);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function assertReadableUploadFile(file: File): Promise<void> {
  if (file.size <= 0) {
    throw new Error('文件大小为 0 B，浏览器记录的是未完成快照。刷新页面无法恢复，请等待文件完成后重新选择。');
  }

  try {
    await file.slice(0, 1).arrayBuffer();
  } catch {
    throw new Error('浏览器无法读取这个文件。请确认文件已下载到本机且未被其他程序占用，然后重新选择。');
  }
}

function getUploadConnectionErrorMessage(): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return '设备当前离线，暂时无法确认上传结果。恢复网络后可重试。';
  }
  return '上传连接被中断，暂时无法确认服务器是否已接收。请稍后查看任务记录或重试。';
}

function appendUploadMetadata(formData: FormData, metadata?: UploadBookMetadata): void {
  const title = metadata?.title?.trim();
  const author = metadata?.author?.trim();
  const description = metadata?.description?.trim();
  const sourceUrl = metadata?.sourceUrl?.trim();
  const tags = metadata?.tags?.map((tag) => tag.trim()).filter(Boolean);
  if (title) formData.set('title', title);
  if (author) formData.set('author', author);
  if (description) formData.set('description', description);
  if (metadata?.publicationStatus) formData.set('publication_status', metadata.publicationStatus);
  if (sourceUrl) formData.set('source_url', sourceUrl);
  if (tags?.length) formData.set('tags', Array.from(new Set(tags)).join(','));
}

function getLocalUploadProgress(status: UploadStatus): number {
  if (status === 'queued') {
    return 0;
  }

  if (status === 'processing') {
    return 72;
  }

  if (status === 'ready') {
    return 100;
  }

  return status === 'failed' ? 0 : 8;
}

function getLocalUploadMessage(fileType: string, status: UploadStatus): string {
  if (status === 'queued') {
    return '等待开始上传';
  }

  if (status === 'processing') {
    return '服务器已接收，正在解析正文和图片';
  }

  if (fileType.includes('图片包') || fileType === 'CBZ') {
    return '正在上传漫画压缩包';
  }

  if (fileType === 'PDF') {
    return '正在上传 PDF 原文件';
  }

  if (IMAGE_FILE_TYPES.includes(fileType)) {
    return '正在上传图集图片';
  }

  return '正在上传电子书';
}

function mapBackendUploadTask(task: BackendUploadTask): UploadTask {
  return {
    bookId: task.book_id ?? undefined,
    errorCode: task.error_code ?? undefined,
    fileName: task.file_name,
    fileSize: task.file_size,
    fileType: task.file_type,
    id: task.id,
    message: getUploadTaskMessage({ errorCode: task.error_code, message: task.message ?? undefined, status: task.status }),
    progress: task.progress,
    status: task.status,
  };
}

function readXhrJson(xhr: XMLHttpRequest): unknown {
  if (!xhr.responseText) {
    return null;
  }

  try {
    return JSON.parse(xhr.responseText);
  } catch {
    return xhr.responseText;
  }
}

function getErrorMessage(payload: unknown, fallback: string): string {
  return getApiErrorMessage(payload, fallback);
}
