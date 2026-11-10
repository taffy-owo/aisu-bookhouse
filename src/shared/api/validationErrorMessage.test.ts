import { describe, expect, it } from 'vitest';
import { getApiErrorMessage } from './apiClient';

describe('API validation messages', () => {
  it('names the rejected model parameter and its bound', () => {
    expect(getApiErrorMessage({ detail: [{ loc: ['body', 'models', 2, 'chunk_characters'], type: 'greater_than_equal', ctx: { ge: 500 } }] }, 'Unprocessable Entity')).toBe('第 3 个模型的分块字数不能小于 500');
  });
  it('explains integer and maximum-length errors', () => {
    expect(getApiErrorMessage({ detail: [{ loc: ['body', 'translation_concurrency'], type: 'int_from_float' }, { loc: ['body', 'translation_prompt'], type: 'string_too_long', ctx: { max_length: 6000 } }] }, '')).toBe('翻译并发请填写整数；翻译预设最多 6000 个字符');
  });
  it('never exposes a rejected secret or unknown field input', () => {
    const message = getApiErrorMessage({ detail: [{ loc: ['body', 'api_key'], type: 'value_error', input: 'test-secret-not-for-errors', msg: 'Rejected test-secret-not-for-errors' }, { loc: ['body', 'unrecognized-secret-field'], input: 'another-secret' }] }, 'Unprocessable Entity');
    expect(message).toBe('API Key填写有误，请检查后重试；输入内容填写有误，请检查后重试');
  });
  it('keeps human-readable server errors unchanged', () => {
    expect(getApiErrorMessage({ detail: '该渠道还有进行中的翻译任务' }, '')).toBe('该渠道还有进行中的翻译任务');
  });
  it('handles malformed issue details without hiding the original failure behind a crash', () => {
    expect(getApiErrorMessage({ detail: [{ loc: ['body', '__proto__'], type: { unexpected: true } }, null, 'unexpected'] }, 'Unprocessable Entity')).toBe('输入内容填写有误，请检查后重试；填写内容有误，请检查后重试');
    expect(getApiErrorMessage({ detail: [] }, '')).toBe('填写内容有误，请检查后重试');
  });
});
