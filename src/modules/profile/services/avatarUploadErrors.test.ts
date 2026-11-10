import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../shared/api';
import { getAvatarUploadError } from './avatarUploadErrors';

describe('avatar upload feedback', () => {
  it.each([
    'Unsupported file format. Please upload PNG, JPG, JPEG, GIF, or WEBP.',
    'Unsupported image type. Please upload PNG, JPG, GIF, or WEBP.',
  ])('explains a rejected image format: %s', (message) => {
    expect(getAvatarUploadError(new ApiError(message, 400))).toBe('请上传 PNG、JPG、GIF 或 WEBP 格式的图片。');
  });

  it('explains image decode and size failures', () => {
    expect(getAvatarUploadError(new ApiError('Invalid image file. Please upload a valid PNG, JPG, GIF, or WEBP image.', 400))).toBe('这张图片无法读取，请重新选择有效图片。');
    expect(getAvatarUploadError(new ApiError('Request Entity Too Large', 413))).toBe('头像图片不能超过 5MB。');
  });

  it('retains specific Chinese recovery instructions', () => {
    expect(getAvatarUploadError(new ApiError('头像刚刚更新，请刷新后重试', 409))).toBe('头像刚刚更新，请刷新后重试');
  });

  it('distinguishes network, unavailable service and unknown failures', () => {
    expect(getAvatarUploadError(new TypeError('Failed to fetch'))).toBe('上传连接失败，请检查网络后重试。');
    expect(getAvatarUploadError(new ApiError('Internal Server Error', 500))).toBe('头像服务暂时不可用，请稍后重试。');
    expect(getAvatarUploadError({})).toBe('头像上传失败，请稍后重试。');
  });
});
