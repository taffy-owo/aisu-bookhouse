import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJapaneseArticleDraft, writeJapaneseArticleDraft } from './japaneseArticleDraft';
import { createPastedJapaneseArticleSubmission } from './pastedJapaneseArticle';
vi.mock('../../books', () => ({ invalidateBookListCache: vi.fn(), updateBook: vi.fn() }));
vi.mock('../../uploads', () => ({ getUploadTasks: vi.fn(), uploadBookFile: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  return values;
}
const input = { content: '桜の花が咲いています。', title: '标题', author: '作者', sourceUrl: 'https://example.com' };
describe('Japanese article drafts', () => {
  it('isolates accounts and removes only the emptied draft', () => {
    storage(); writeJapaneseArticleDraft('a', { input }); writeJapaneseArticleDraft('b', { input: { content: 'B' } });
    expect(readJapaneseArticleDraft('a')?.input).toEqual(input);
    expect(readJapaneseArticleDraft('b')?.input.content).toBe('B');
    writeJapaneseArticleDraft('a', { input: { content: '' } });
    expect(readJapaneseArticleDraft('a')).toBeNull(); expect(readJapaneseArticleDraft('b')).not.toBeNull();
  });
  it('recovers pending and completed receipts with their original identity', () => {
    storage(); const submission = createPastedJapaneseArticleSubmission(input);
    submission.receipt = { bookId: 'b', taskId: 't' };
    writeJapaneseArticleDraft('a', { input, submission });
    expect(readJapaneseArticleDraft('a')?.submission).toMatchObject({ requestId: submission.requestId, completed: false, receipt: submission.receipt });
    submission.metadataSaved = true; submission.completed = true;
    writeJapaneseArticleDraft('a', { input, submission });
    expect(readJapaneseArticleDraft('a')?.submission?.completed).toBe(true);
  });
  it('keeps edited text without reusing an unrelated receipt', () => {
    storage(); writeJapaneseArticleDraft('a', { input: { ...input, content: 'changed' }, submission: createPastedJapaneseArticleSubmission(input) });
    expect(readJapaneseArticleDraft('a')).toEqual({ input: { ...input, content: 'changed' }, submission: undefined });
  });
  it('tolerates corrupt data, invalid submission fields and unavailable storage', () => {
    const values = storage(); const key = 'aisu-bookhouse:japanese-article-draft:a';
    values.set(key, '{'); expect(readJapaneseArticleDraft('a')).toBeNull();
    values.set(key, JSON.stringify({ input, submission: { ...createPastedJapaneseArticleSubmission(input), input: { ...input, title: 99 } } }));
    expect(readJapaneseArticleDraft('a')?.input).toEqual(input); expect(readJapaneseArticleDraft('a')?.submission).toBeUndefined();
    vi.stubGlobal('window', { get sessionStorage() { throw new Error('denied'); } });
    expect(readJapaneseArticleDraft('a')).toBeNull(); expect(writeJapaneseArticleDraft('a', { input })).toBe(false);
  });
});
