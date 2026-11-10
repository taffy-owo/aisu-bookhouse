import { describe, expect, it } from 'vitest';
import { reconcileSubmittedFields } from './reconcileSubmittedFields';

describe('acknowledged form fields', () => {
  it('keeps edits made while the submitted values were saving', () => {
    const submitted = { model: 'old-model', prompt: 'old prompt', concurrency: 2 };
    expect(reconcileSubmittedFields({ model: 'new-model', prompt: 'new prompt', concurrency: 3 }, submitted, submitted))
      .toEqual({ model: 'new-model', prompt: 'new prompt', concurrency: 3 });
  });

  it('applies normalization to unchanged fields while retaining changed ones', () => {
    const submitted = { baseUrl: ' https://example.test/v1 ', model: 'old-model' };
    const current = { ...submitted, model: 'new-model' };
    expect(reconcileSubmittedFields(current, submitted, { baseUrl: 'https://example.test/v1', model: 'old-model' }))
      .toEqual({ baseUrl: 'https://example.test/v1', model: 'new-model' });
    expect(current).toEqual({ ...submitted, model: 'new-model' });
  });

  it('clears only the acknowledged secret, preserving a newly entered replacement', () => {
    expect(reconcileSubmittedFields({ apiKey: 'new-local-fixture-key' }, { apiKey: 'submitted-local-fixture-key' }, { apiKey: '' }).apiKey)
      .toBe('new-local-fixture-key');
    expect(reconcileSubmittedFields({ apiKey: 'submitted-local-fixture-key' }, { apiKey: 'submitted-local-fixture-key' }, { apiKey: '' }).apiKey)
      .toBe('');
  });

  it('acknowledges a value that was changed and then restored to the submitted value', () => {
    expect(reconcileSubmittedFields({ value: ' submitted ' }, { value: ' submitted ' }, { value: 'submitted' }).value).toBe('submitted');
  });
});
