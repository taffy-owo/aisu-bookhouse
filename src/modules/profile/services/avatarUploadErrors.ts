import { ApiError } from '../../../shared/api';

/** Keep upload failures actionable without exposing backend/browser English. */
export function getAvatarUploadError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if ((error instanceof ApiError && error.status === 413) || message.startsWith('Avatar image cannot exceed')) {
    return '头像图片不能超过 5MB。';
  }
  if (message.startsWith('Unsupported file format.') || message.startsWith('Unsupported image type.')) {
    return '请上传 PNG、JPG、GIF 或 WEBP 格式的图片。';
  }
  if (message.startsWith('Invalid image file.') || message === 'Failed to load avatar image') {
    return '这张图片无法读取，请重新选择有效图片。';
  }
  if (message === 'User not found') return '未能找到当前账号，请刷新后重试。';
  if (/[\u3400-\u9fff]/u.test(message)) return message;
  if (error instanceof TypeError) return '上传连接失败，请检查网络后重试。';
  if (error instanceof ApiError && error.status >= 500) return '头像服务暂时不可用，请稍后重试。';
  return '头像上传失败，请稍后重试。';
}
