import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { createReaderNoteDraft } from './readerNoteDraft';
import type { ReaderMarkCreateInput } from '../types/reader';

const origin: ReaderMarkCreateInput = { kind: 'note', label: 'Chapter 1', readerType: 'text', chapterIndex: 1, positionKey: 'old-chapter', progressPercent: 12 };
let sequence = 0;
let bookId: string;
let storage: Map<string, string>;
beforeEach(() => {
  clearAuthStorage(); bookId = `draft-book-${++sequence}`; storage = new Map();
  vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
});
afterEach(() => { vi.unstubAllGlobals(); clearAuthStorage(); });
describe('reader note draft continuity', () => {
  it('retains text and its original coordinates when another reader mounts', () => {
    const old = createReaderNoteDraft(bookId); old.update(() => ({ text: '未保存的想法', origin }));
    expect(createReaderNoteDraft(bookId).getSnapshot()).toMatchObject({ text: '未保存的想法', origin });
    expect([...storage.values()].map((value) => JSON.parse(value))).toEqual([{ text: '未保存的想法', origin }]);
  });
  it('does not let a late save erase edits made in the new reader', () => {
    const old = createReaderNoteDraft(bookId); old.update(() => ({ text: '旧草稿', origin })); const revision = old.getSnapshot().revision;
    const next = createReaderNoteDraft(bookId); next.update(() => ({ text: '新草稿', origin: { ...origin, readerType: 'comic', imageIndex: 2, positionKey: undefined } }));
    old.clearIfRevision(revision); expect(next.getSnapshot().text).toBe('新草稿');
  });
  it('preserves a draft edited and restored to the same text during saving', () => {
    const draft = createReaderNoteDraft(bookId); draft.update(() => ({ text: '原文', origin })); const revision = draft.getSnapshot().revision;
    draft.update(() => ({ text: '修改', origin })); draft.update(() => ({ text: '原文', origin })); draft.clearIfRevision(revision);
    expect(draft.getSnapshot().text).toBe('原文');
  });
  it('clears only the exact confirmed draft and its persisted copy', () => {
    const draft = createReaderNoteDraft(bookId); draft.update(() => ({ text: '已保存', origin })); draft.clearIfRevision(draft.getSnapshot().revision);
    expect(draft.getSnapshot().text).toBe(''); expect(storage.size).toBe(0);
  });
  it('keeps books and accounts isolated and ignores old-account callbacks', () => {
    const first = createReaderNoteDraft(bookId); first.update(() => ({ text: '私有草稿', origin }));
    expect(createReaderNoteDraft(bookId + '-other').getSnapshot().text).toBe('');
    setStoredSession({ id: 'other-account', nickname: 'Other', role: 'user' });
    expect(createReaderNoteDraft(bookId).getSnapshot().text).toBe(''); first.clearIfRevision(first.getSnapshot().revision);
    clearAuthStorage(); expect(createReaderNoteDraft(bookId).getSnapshot().text).toBe('私有草稿');
  });
  it('keeps the draft if storage is blocked or full', () => {
    vi.stubGlobal('window', { get sessionStorage() { throw Error('blocked'); } });
    const draft = createReaderNoteDraft(bookId); draft.update(() => ({ text: '仍可编辑', origin })); expect(draft.getSnapshot().text).toBe('仍可编辑');
  });
  it('restores a session draft after module reload without carrying old save revisions', async () => {
    const draft = createReaderNoteDraft(bookId); draft.update(() => ({ text: '刷新后保留', origin }));
    vi.resetModules(); const fresh = await import('./readerNoteDraft');
    expect(fresh.createReaderNoteDraft(bookId).getSnapshot()).toMatchObject({ text: '刷新后保留', origin, revision: 0 });
  });
  it.each(['{broken', JSON.stringify({ text: 'bad', origin: { readerType: 'other' } }), JSON.stringify({ text: 'x'.repeat(2001), origin })])('ignores malformed stored drafts: %s', (value) => {
    storage.set(`aisu:reader-note-draft:${JSON.stringify(['null', bookId])}`, value);
    expect(createReaderNoteDraft(bookId).getSnapshot().text).toBe('');
  });
});
