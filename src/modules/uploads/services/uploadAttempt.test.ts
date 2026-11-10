import { afterEach, describe, expect, it } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { createUploadAttempt } from './uploadAttempt';
import { EMPTY_MANUAL_BOOK_DRAFT, prepareManualBook, reserveManualBookSubmission, updateManualBookDraft } from './manualBookDraft';

afterEach(clearAuthStorage);
describe('upload retry identity', () => {
  it('captures the original metadata independently from later form edits', () => {
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    const metadata = { title: '标题', author: '作者', tags: ['翻译'] };
    const file = new File(['正文'], 'book.txt');
    const attempt = createUploadAttempt(file, metadata);
    metadata.author = '后来编辑'; metadata.tags.push('其他');
    expect(attempt.file).toBe(file);
    expect(attempt.metadata).toEqual({ title: '标题', author: '作者', tags: ['翻译'] });
    expect(attempt.accountScope).toBe('"a"');
    expect(attempt.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves one request id and dated title for an unchanged manual submission', () => {
    const draft = reserveManualBookSubmission({ ...EMPTY_MANUAL_BOOK_DRAFT, content: '很长的正文'.repeat(50) });
    expect(reserveManualBookSubmission(draft)).toEqual(draft);
    const prepared = prepareManualBook(draft, new Date(2030, 0, 1));
    expect(prepared.title).not.toBe('手动文章 2030-01-01');
    expect(updateManualBookDraft(draft, { ...draft })).toEqual(draft);
  });

  it.each(['content', 'author', 'title', 'tags', 'sourceUrl'] as const)('starts a new manual request when %s changes', (field) => {
    const draft = reserveManualBookSubmission({ ...EMPTY_MANUAL_BOOK_DRAFT, content: '正文' });
    const edited = updateManualBookDraft(draft, { ...draft, [field]: '新内容' });
    expect(edited.requestId).toBeUndefined();
    expect(edited.submittedAt).toBeUndefined();
    expect(reserveManualBookSubmission(edited).requestId).not.toBe(draft.requestId);
  });
});
