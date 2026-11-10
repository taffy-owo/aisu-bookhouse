import { ApiError } from '../../../shared/api';

export type ReaderStartupError = { status: 'missing' | 'unavailable'; message: string };

export function getReaderStartupError(error: unknown): ReaderStartupError {
  if (error instanceof ApiError && error.status === 404) {
    return { status: 'missing', message: '书籍可能已被移除，或当前账号没有访问权限。' };
  }
  return {
    status: 'unavailable',
    message: error instanceof ApiError && error.message ? error.message : '请检查网络连接后重试。',
  };
}
