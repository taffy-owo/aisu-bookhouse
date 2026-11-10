import { invalidateBookListCache, updateBook } from '../../books';
import { getUploadTasks, uploadBookFile } from '../../uploads';
import { createRequestId } from '../../../shared/utils/requestId';

const MAX_ARTICLE_CHARS = 1_000_000;
const MIN_ARTICLE_CHARS = 30;

export interface PastedJapaneseArticleInput {
  author?: string;
  content: string;
  sourceUrl?: string;
  title?: string;
}

export interface PastedJapaneseArticleImport {
  bookId: string;
  taskId: string;
}

export interface PastedJapaneseArticleSubmission {
  completed?: boolean;
  input: PastedJapaneseArticleInput;
  metadataSaved: boolean;
  receipt?: PastedJapaneseArticleImport;
  requestId: string;
}

export function createPastedJapaneseArticleSubmission(input: PastedJapaneseArticleInput): PastedJapaneseArticleSubmission {
  return { input: { ...input }, metadataSaved: false, requestId: createRequestId() };
}

export function matchesPastedJapaneseArticleSubmission(submission: PastedJapaneseArticleSubmission, input: PastedJapaneseArticleInput): boolean {
  return normalizeArticleText(submission.input.content) === normalizeArticleText(input.content)
    && submission.input.author?.trim() === input.author?.trim()
    && submission.input.sourceUrl?.trim() === input.sourceUrl?.trim()
    && submission.input.title?.trim() === input.title?.trim();
}

export function validatePastedJapaneseArticle(input: PastedJapaneseArticleInput): string | null {
  const content = normalizeArticleText(input.content);
  if (content.length < MIN_ARTICLE_CHARS) return `正文至少需要 ${MIN_ARTICLE_CHARS} 个字符`;
  if (content.length > MAX_ARTICLE_CHARS) return '正文过长，请拆成多篇文章导入';
  if (!/[\u3040-\u30ff]/u.test(content)) return '正文中没有检测到日文假名，请确认粘贴的是日文原文';
  if (input.sourceUrl?.trim()) {
    try {
      const url = new URL(input.sourceUrl.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '原文链接必须是 http 或 https 地址';
    } catch {
      return '原文链接格式不正确';
    }
  }
  return null;
}

export function resolvePastedJapaneseArticleTitle(input: PastedJapaneseArticleInput): string {
  const providedTitle = input.title?.trim();
  if (providedTitle) return providedTitle;

  const firstLine = normalizeArticleText(input.content)
    .split('\n')
    .find((line) => line.trim())
    ?.replace(/\s+/g, ' ')
    .trim();
  if (!firstLine) return '日文文章';
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
}

export function createPastedJapaneseArticleFile(title: string, content: string): File {
  const safeTitle = sanitizeFileName(title.trim()) || '日文文章';
  return new File([normalizeArticleText(content)], `${safeTitle}.txt`, { type: 'text/plain;charset=utf-8' });
}

export async function importPastedJapaneseArticle(input: PastedJapaneseArticleInput, options: { signal?: AbortSignal; submission?: PastedJapaneseArticleSubmission; onSubmissionChange?: () => void } = {}): Promise<PastedJapaneseArticleImport> {
  options.signal?.throwIfAborted();
  const validationError = validatePastedJapaneseArticle(input);
  if (validationError) throw new Error(validationError);

  const submission = options.submission;
  const title = resolvePastedJapaneseArticleTitle(input);
  const author = input.author?.trim() || '网络文章';
  let receipt = submission?.receipt;
  if (!receipt) {
    const file = createPastedJapaneseArticleFile(title, input.content);
    const response = await uploadBookFile(file, {
      requestId: submission?.requestId,
      metadata: { author, tags: ['日文', '粘贴文章'], title },
      signal: options.signal,
    });
    if (!response.book_id) throw new Error('文章已上传，但没有创建书籍记录');
    receipt = { bookId: response.book_id, taskId: response.task_id };
    if (submission) submission.receipt = receipt;
    options.onSubmissionChange?.();
  }

  if (!submission?.metadataSaved) {
    options.signal?.throwIfAborted();
    await updateBook(receipt.bookId, {
      author,
      language: 'ja',
      sourceUrl: input.sourceUrl?.trim() || null,
      tags: ['日文', '粘贴文章'],
      title,
    }, options.signal);
    options.signal?.throwIfAborted();
    if (submission) submission.metadataSaved = true;
    options.onSubmissionChange?.();
  }
  await waitForPastedArticleReady(receipt.taskId, options.signal);
  options.signal?.throwIfAborted();
  if (submission) submission.completed = true;
  options.onSubmissionChange?.();
  invalidateBookListCache();
  return receipt;
}

export async function waitForPastedArticleReady(taskId: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('已停止等待', 'AbortError');
    const task = (await getUploadTasks(signal)).find((item) => item.id === taskId);
    signal?.throwIfAborted();
    if (task?.status === 'ready') {
      invalidateBookListCache();
      return;
    }
    if (task?.status === 'failed') throw new Error(task.message || '文章解析失败');
    await delay(750, signal);
  }
  throw new Error('文章仍在后台解析，可前往上传页面查看进度');
}

function normalizeArticleText(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function sanitizeFileName(value: string): string {
  const withoutControlCharacters = Array.from(value, (character) => (character.charCodeAt(0) < 32 ? ' ' : character)).join('');
  return withoutControlCharacters.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('已停止等待', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
