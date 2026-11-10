import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { getChapterDraft } from './chapterDraft';

let sequence = 0;
let bookId: string;
let storage: Map<string, string>;
const value = { title: '第二话', content: '还没写完的正文。', preparedBody: true, baseRevision: 'a'.repeat(64) };
const setItem = vi.fn((key: string, data: string) => { storage.set(key, data); });
beforeEach(() => {
  clearAuthStorage(); bookId = `chapter-draft-${++sequence}`; storage = new Map();
  setItem.mockClear(); vi.useFakeTimers();
  vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem, removeItem: (key: string) => storage.delete(key) } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); clearAuthStorage(); });

describe('chapter draft continuity', () => {
  it('restores body, title, formatting state and the original server revision after a reload', async () => {
    const draft = getChapterDraft(bookId, 2); draft.update(value); draft.flush();
    vi.resetModules(); const fresh = await import('./chapterDraft');
    expect(fresh.getChapterDraft(bookId, 2).getSnapshot().value).toEqual(value);
  });
  it('coalesces typing and can flush before closing without losing the last character', () => {
    const draft = getChapterDraft(bookId, 2);
    for (let i = 0; i < 100; i++) draft.update({ ...value, content: `输入${i}` });
    expect(setItem).not.toHaveBeenCalled();
    draft.flush(); vi.advanceTimersByTime(500);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse([...storage.values()][0]).content).toBe('输入99');
  });
  it('retains title-only append drafts and intentionally empty edit bodies', () => {
    const append = getChapterDraft(bookId, 'append'); append.update({ title: '下次继续', content: '', preparedBody: false }); append.flush();
    const edit = getChapterDraft(bookId, 2); edit.update({ ...value, content: '' }); edit.flush();
    expect(storage.size).toBe(2);
    expect(getChapterDraft(bookId, 2).getSnapshot().value?.content).toBe('');
  });
  it('isolates chapters, books, accounts and ignores old-account input', () => {
    const original = getChapterDraft(bookId, 2); original.update(value); original.flush();
    expect(getChapterDraft(bookId, 1).getSnapshot().value).toBeNull();
    expect(getChapterDraft(bookId + 'other', 2).getSnapshot().value).toBeNull();
    setStoredSession({ id: 'another-user', role: 'user', nickname: 'Other' });
    expect(getChapterDraft(bookId, 2).getSnapshot().value).toBeNull();
    original.update({ ...value, content: '旧账号迟到的输入' });
    expect(original.getSnapshot().value).toEqual(value);
  });
  it('a late success clears only its exact draft, even after the text was changed and changed back', () => {
    const draft = getChapterDraft(bookId, 2); draft.update(value); const version = draft.getSnapshot().version;
    draft.update({ ...value, content: '新输入' }); draft.update(value); draft.clearIfVersion(version);
    expect(draft.getSnapshot().value).toEqual(value);
    draft.clearIfVersion(draft.getSnapshot().version);
    expect(draft.getSnapshot().value).toBeNull(); expect(storage.size).toBe(0);
    vi.advanceTimersByTime(500); expect(storage.size).toBe(0);
  });
  it('keeps the newest text in memory when storage is unavailable and persists it on retry', () => {
    const draft = getChapterDraft(bookId, 2);
    setItem.mockImplementationOnce(() => { throw Error('full'); });
    draft.update(value); draft.flush();
    expect(draft.getSnapshot()).toMatchObject({ value, pending: true, issue: 'save' });
    draft.retry(); expect(draft.getSnapshot()).toMatchObject({ value, pending: false, issue: null });
  });
  it('does not resurrect a confirmed draft while retrying failed cleanup', () => {
    const draft = getChapterDraft(bookId, 2); draft.update(value); draft.flush();
    vi.stubGlobal('window', { get sessionStorage() { throw Error('blocked'); } });
    draft.clearIfVersion(draft.getSnapshot().version);
    expect(getChapterDraft(bookId, 2).getSnapshot()).toMatchObject({ value: null, issue: 'clear' });
  });
  it.each(['{broken', JSON.stringify({ title: '旧正文', content: '不能用新章节版本保存', preparedBody: true })])('reports unreadable or versionless edit drafts without treating them as current prose', (raw) => {
    storage.set(`aisu-bookhouse:chapter-draft:${JSON.stringify(['null', bookId, 2])}`, raw);
    expect(getChapterDraft(bookId, 2).getSnapshot()).toMatchObject({ value: null, issue: 'read' });
    expect([...storage.values()]).toEqual([raw]);
  });
});
