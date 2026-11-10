import { describe, expect, it, vi } from 'vitest';
import type { PublicComment } from './types';
import { EMPTY_COMMENT_COLLECTION, addCreatedComment, applyCommentPage, getCommentCollectionItems, hasCommentPageDrift, loadCommentWindow, removeDeletedComment } from './commentCollection';

const comment = (id: string): PublicComment => ({ id, body: id, bookId: 'one', userId: 'reader', userNickname: '读者', targetType: 'book', createdAt: '2026-10-27', updatedAt: '2026-10-27' });
const initial = () => applyCommentPage(EMPTY_COMMENT_COLLECTION, { items: [comment('a'), comment('b')], total: 5 });

describe('refreshing an expanded comment thread', () => {
  it('reloads the opened prefix without fetching every remaining comment', async () => {
    const load = vi.fn().mockResolvedValueOnce({ items: [comment('a'), comment('b')], total: 8 })
      .mockResolvedValueOnce({ items: [comment('c'), comment('d')], total: 8 });
    expect((await loadCommentWindow(load, 4, new AbortController().signal)).items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(load.mock.calls).toEqual([[0], [2]]);
  });

  it('stops after the remaining comments when a thread has shrunk', async () => {
    const load = vi.fn().mockResolvedValue({ items: [comment('a')], total: 1 });
    expect((await loadCommentWindow(load, 6, new AbortController().signal)).total).toBe(1);
    expect(load).toHaveBeenCalledOnce();
  });

  it('rejects a partial refresh when a later page fails', async () => {
    const load = vi.fn().mockResolvedValueOnce({ items: [comment('a')], total: 4 }).mockRejectedValueOnce(new Error('offline'));
    await expect(loadCommentWindow(load, 3, new AbortController().signal)).rejects.toThrow('offline');
  });

  it.each([
    { items: [comment('b')], total: 5 },
    { items: [comment('a')], total: 4 },
    { items: [], total: 4 },
  ])('rejects a changed or stalled prefix: %j', async (page) => {
    const load = vi.fn().mockResolvedValueOnce({ items: [comment('a')], total: 4 }).mockResolvedValueOnce(page);
    await expect(loadCommentWindow(load, 3, new AbortController().signal)).rejects.toThrow('评论列表正在变化');
  });

  it('stops an obsolete refresh even when its fetch ignores cancellation', async () => {
    const controller = new AbortController();
    const load = vi.fn(async () => { controller.abort(); return { items: [comment('a')], total: 4 }; });
    await expect(loadCommentWindow(load, 3, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).toHaveBeenCalledOnce();
  });
});

describe('comment pagination and local confirmations', () => {
  it('does not count a new tail comment as a loaded server offset', () => {
    const state = addCreatedComment(initial(), comment('new'));
    expect(state.loaded.length).toBe(2);
    expect(state.total).toBe(6);
    expect(getCommentCollectionItems(state).map((item) => item.id)).toEqual(['a', 'b', 'new']);
  });
  it('fills the unseen middle before the locally posted tail', () => {
    const state = applyCommentPage(addCreatedComment(initial(), comment('new')), { items: [comment('c'), comment('d')], total: 6 }, true);
    expect(state.loaded.length).toBe(4);
    expect(getCommentCollectionItems(state).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'new']);
  });
  it('deduplicates a confirmed new comment when its server page is reached', () => {
    const state = applyCommentPage(addCreatedComment(initial(), comment('new')), { items: [comment('c'), comment('d'), comment('e'), comment('new')], total: 6 }, true);
    expect(state.posted).toEqual([]);
    expect(getCommentCollectionItems(state)).toHaveLength(6);
  });
  it('keeps a post made before the initial request finishes visible during a fresh read', () => {
    const state = applyCommentPage(addCreatedComment(EMPTY_COMMENT_COLLECTION, comment('new')), { items: [comment('a'), comment('b')], total: 6 });
    expect(getCommentCollectionItems(state).map((item) => item.id)).toEqual(['a', 'b', 'new']);
  });
  it('does not duplicate a post already observed by a successful read', () => {
    const state = initial();
    expect(addCreatedComment(state, comment('a'))).toBe(state);
  });
  it('keeps confirmed posts when reloading a previously complete thread', () => {
    const full = applyCommentPage(EMPTY_COMMENT_COLLECTION, { items: [comment('a'), comment('b')], total: 2 });
    const state = applyCommentPage(addCreatedComment(full, comment('new')), { items: [comment('a'), comment('b')], total: 3 });
    expect(getCommentCollectionItems(state)).toHaveLength(3);
  });
  it('reduces the contiguous offset after deleting a loaded comment', () => {
    const state = removeDeletedComment(initial(), 'a');
    expect(state.loaded.map((item) => item.id)).toEqual(['b']);
    expect(state.total).toBe(4);
  });
  it('leaves the server offset unchanged after deleting a local tail comment', () => {
    const state = removeDeletedComment(addCreatedComment(initial(), comment('new')), 'new');
    expect(state.loaded).toHaveLength(2);
    expect(state.posted).toEqual([]);
    expect(state.total).toBe(5);
  });
  it('does not decrement the total for an already removed item', () => {
    const state = removeDeletedComment(initial(), 'a');
    expect(removeDeletedComment(state, 'a')).toBe(state);
  });
  it('accepts a server page containing a locally posted tail', () => {
    expect(hasCommentPageDrift(addCreatedComment(initial(), comment('new')), { items: [comment('c'), comment('new')], total: 6 })).toBe(false);
  });
  it.each([
    { items: [comment('c')], total: 4 },
    { items: [comment('c')], total: 6 },
    { items: [comment('b'), comment('c')], total: 5 },
    { items: [], total: 5 },
  ])('detects changed offsets rather than silently skipping comments: %j', (page) => {
    expect(hasCommentPageDrift(initial(), page)).toBe(true);
  });
});
