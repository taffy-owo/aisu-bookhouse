import { expect, it } from 'vitest';
import { sourceTranslationNotice, type WorkSourceMetadata } from './sourceMetadataService';

const metadata = { translation_status: 'unavailable' } as WorkSourceMetadata;
it('shows the actual channel and failure reason, not a generic busy message', () => {
  const notice = sourceTranslationNotice({ ...metadata, translation_channel: 'gg', translation_model: 'agy-test', translation_error_message: '密钥认证失败' });
  expect(notice).toContain('gg · agy-test');
  expect(notice).toContain('密钥认证失败');
  expect(notice).not.toContain('正忙');
});
it('supports older API responses without inventing a failure reason', () => {
  expect(sourceTranslationNotice(metadata)).toContain('暂不可用');
  expect(sourceTranslationNotice(metadata)).not.toContain('稍后');
});
it('does not warn for a successful translation', () => {
  expect(sourceTranslationNotice({ ...metadata, translation_status: 'translated' })).toBe('');
});
