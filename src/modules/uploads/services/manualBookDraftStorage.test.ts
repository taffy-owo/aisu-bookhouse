import { describe, expect, it } from 'vitest';
import { EMPTY_MANUAL_BOOK_DRAFT } from './manualBookDraft';
import { createManualBookDraftStorage } from './manualBookDraftStorage';

function fixture() {
  const data = new Map<string, string>();
  const state = { failRead: false, failSave: false, failClear: false, owner: 'a' };
  const storage = {
    getItem(key: string) { if (state.failRead) throw new Error('blocked'); return data.get(key) ?? null; },
    setItem(key: string, value: string) { if (state.failSave) throw new Error('full'); data.set(key, value); },
    removeItem(key: string) { if (state.failClear) throw new Error('blocked'); data.delete(key); },
  } as Storage;
  return { data, state, store: createManualBookDraftStorage(() => storage, () => state.owner) };
}
const draft = { ...EMPTY_MANUAL_BOOK_DRAFT, title: '来信', content: '尚未提交的正文。', requestId: 'submission-a', submittedAt: '2026-10-30T00:00:00Z' };

describe('manual draft persistence recovery', () => {
  it('retains the latest failed edit with its submission receipt and retries that snapshot', () => {
    const { data, state, store } = fixture();
    expect(store.save(draft)).toBe(true);
    state.failSave = true;
    const newer = { ...draft, content: '修改后的正文。', requestId: undefined, submittedAt: undefined };
    expect(store.save(newer)).toBe(false);
    expect(JSON.parse(data.get('a')!).content).toBe(draft.content);
    expect(store.read()).toEqual({ draft: newer, issue: 'save' });
    expect(store.retry()).toEqual({ draft: newer, issue: 'save' });
    state.failSave = false;
    expect(store.retry()).toEqual({ draft: newer, issue: null });
    expect(store.read()).toEqual({ draft: newer, issue: null });
    expect(JSON.parse(data.get('a')!)).toEqual(newer);
  });
  it('prevents a confirmed deletion from restoring an old submission and retries only the deletion', () => {
    const { data, state, store } = fixture();
    store.save(draft); state.failClear = true;
    expect(store.clear()).toBe(false);
    expect(data.has('a')).toBe(true);
    expect(store.read()).toEqual({ draft: null, issue: 'clear' });
    expect(store.retry()).toEqual({ draft: null, issue: 'clear' });
    state.failClear = false;
    expect(store.retry()).toEqual({ draft: null, issue: null });
    expect(data.has('a')).toBe(false);
  });
  it('keeps both failed saves and deletion markers isolated across accounts', () => {
    const { state, store, data } = fixture();
    state.failSave = true; store.save(draft);
    state.owner = 'b';
    expect(store.read()).toEqual({ draft: null, issue: null });
    store.save({ ...draft, content: '第二个账号的正文。' });
    state.failSave = false; store.retry();
    expect(data.has('a')).toBe(false);
    expect(JSON.parse(data.get('b')!).content).toBe('第二个账号的正文。');
    state.owner = 'a';
    expect(store.read()).toEqual({ draft, issue: 'save' });
    store.retry(); state.failClear = true; store.clear();
    state.owner = 'b';
    expect(store.read().draft?.content).toBe('第二个账号的正文。');
    expect(data.has('a')).toBe(true);
  });
  it('reports an unreadable record without deleting it and can recover it later', () => {
    const { state, store, data } = fixture();
    store.save(draft); state.failRead = true;
    expect(store.read()).toEqual({ draft: null, issue: 'read' });
    expect(data.has('a')).toBe(true);
    state.failRead = false;
    expect(store.retry()).toEqual({ draft, issue: null });
  });
  it('preserves malformed data until an explicit replacement instead of silently erasing it', () => {
    const { store, data } = fixture(); data.set('a', '{broken');
    expect(store.read()).toEqual({ draft: null, issue: 'read' });
    expect(data.get('a')).toBe('{broken');
    expect(store.save(draft)).toBe(true);
    expect(store.read().draft).toEqual(draft);
  });
  it('still discards metadata-only records and retains a failed deletion for retry', () => {
    const { state, store, data } = fixture();
    data.set('a', JSON.stringify({ ...draft, content: '' })); state.failClear = true;
    expect(store.read()).toEqual({ draft: null, issue: 'clear' });
    state.failClear = false; store.retry();
    expect(data.has('a')).toBe(false);
    store.save({ ...draft, content: '   ' });
    expect(store.read()).toEqual({ draft: null, issue: null });
  });
  it('retains work when accessing the storage property itself throws', () => {
    const store = createManualBookDraftStorage(() => { throw new Error('blocked storage property'); }, () => 'a');
    expect(store.read().issue).toBe('read');
    expect(store.save(draft)).toBe(false);
    expect(store.read()).toEqual({ draft, issue: 'save' });
    expect(store.clear()).toBe(false);
    expect(store.read()).toEqual({ draft: null, issue: 'clear' });
  });
});
