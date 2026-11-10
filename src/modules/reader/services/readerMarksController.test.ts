import { describe, expect, it, vi } from 'vitest';
import { createReaderMarksController } from './readerMarksController';
import type { ReaderMark, ReaderMarkCreateInput } from '../types/reader';

const input: ReaderMarkCreateInput = { kind: 'note', note: '草稿', label: '第一章', readerType: 'text', chapterIndex: 1, progressPercent: 10 };
const mark: ReaderMark = { ...input, note: '草稿', id: 'mark-one', bookId: 'book-a', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' };
function fixture() {
  const api = { load: vi.fn().mockResolvedValue([mark]), create: vi.fn().mockResolvedValue(mark), remove: vi.fn().mockResolvedValue(undefined), relocate: vi.fn().mockResolvedValue({ ...mark, positionValid: true, positionKey: 'new', chapterIndex: 3 }) };
  const account = { id: 'account-a' };
  const controller = createReaderMarksController('book-a', api, () => account.id);
  return { api, account, controller };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('book and account scoped reader mark mutations', () => {
  it('serializes relocation against repeated clicks and deletion of the same note', async () => {
    const { api, controller } = fixture(); controller.seed([mark]);
    const held = deferred<ReaderMark>(); api.relocate.mockReturnValueOnce(held.promise);
    const pending = controller.relocate(mark, input);
    expect(controller.getSnapshot().relocatingIds).toEqual([mark.id]);
    expect(await controller.relocate(mark, input)).toBe(false);
    expect(await controller.remove(mark)).toBe(false);
    expect(api.remove).not.toHaveBeenCalled(); expect(api.relocate).toHaveBeenCalledTimes(1);
    held.resolve({ ...mark, positionValid: true, positionKey: 'new' });
    expect(await pending).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ relocatingIds: [], marks: [{ id: mark.id, note: mark.note, positionKey: 'new' }] });
  });
  it('keeps a confirmed relocation over an older list snapshot', async () => {
    const { api, controller } = fixture(); controller.seed([{ ...mark, positionValid: false }]);
    const held = deferred<ReaderMark[]>(); api.load.mockReturnValueOnce(held.promise);
    const loading = controller.load();
    expect(await controller.relocate(mark, input)).toBe(true);
    held.resolve([mark]); await loading;
    expect(controller.getSnapshot().marks).toMatchObject([{ positionKey: 'new', chapterIndex: 3, positionValid: true }]);
  });
  it('aborts relocation on reset and ignores an old result without clearing a new pending action', async () => {
    const { api, controller } = fixture(); const old = deferred<ReaderMark>(); const next = deferred<ReaderMark>();
    api.relocate.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const previous = controller.relocate(mark, input); const oldSignal = api.relocate.mock.calls[0][3];
    controller.reset(); expect(oldSignal.aborted).toBe(true);
    const current = controller.relocate(mark, input); old.resolve(mark);
    expect(await previous).toBe(false); expect(controller.getSnapshot().relocatingIds).toEqual([mark.id]);
    next.resolve({ ...mark, positionKey: 'current' }); expect(await current).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ relocatingIds: [], marks: [{ positionKey: 'current' }] });
  });
  it('retains an invalid note on failure and allows relocation to be retried', async () => {
    const { api, controller } = fixture(); const invalid = { ...mark, positionValid: false }; controller.seed([invalid]);
    api.relocate.mockRejectedValueOnce(new Error('离线'));
    expect(await controller.relocate(invalid, input)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ marks: [invalid], relocatingIds: [], error: '离线' });
    expect(await controller.relocate(invalid, input)).toBe(true);
  });
  it('rejects a wrong mark identity and a late response after an account switch', async () => {
    const { api, account, controller } = fixture(); controller.seed([mark]);
    api.relocate.mockResolvedValueOnce({ ...mark, id: 'another-note' });
    expect(await controller.relocate(mark, input)).toBe(false); expect(controller.getSnapshot().marks).toEqual([mark]);
    const held = deferred<ReaderMark>(); api.relocate.mockReturnValueOnce(held.promise);
    const pending = controller.relocate(mark, input); account.id = 'account-b'; held.resolve(mark);
    expect(await pending).toBe(false); expect(controller.getSnapshot().marks).toEqual([]);
    expect(await controller.relocate(mark, input)).toBe(false);
  });
  it('does not clear a newer mutation error when an older relocation finishes', async () => {
    const { api, controller } = fixture(); const held = deferred<ReaderMark>(); api.relocate.mockReturnValueOnce(held.promise);
    const pending = controller.relocate(mark, input); api.create.mockRejectedValueOnce(new Error('新备注保存失败'));
    await controller.create(input); held.resolve({ ...mark, positionKey: 'new' }); await pending;
    expect(controller.getSnapshot().error).toBe('新备注保存失败');
  });
  it('reports a rejected save as unconfirmed and permits a retry', async () => {
    const { api, controller } = fixture();
    api.create.mockRejectedValueOnce(new Error('离线'));
    expect(await controller.create(input)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], error: '离线', isSaving: false });
    expect(await controller.create(input)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], error: null, isSaving: false });
  });
  it('serializes saves before React can render a disabled button', async () => {
    const { api, controller } = fixture();
    const held = deferred<ReaderMark>();
    api.create.mockReturnValueOnce(held.promise);
    const first = controller.create(input);
    expect(await controller.create(input)).toBe(false);
    expect(api.create).toHaveBeenCalledTimes(1);
    held.resolve(mark);
    expect(await first).toBe(true);
  });
  it('ignores an old confirmation after reset without clearing the new pending save', async () => {
    const { api, controller } = fixture();
    const old = deferred<ReaderMark>();
    const next = deferred<ReaderMark>();
    api.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const previous = controller.create(input);
    controller.reset();
    const current = controller.create({ ...input, note: '新备注' });
    old.resolve(mark);
    expect(await previous).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], isSaving: true });
    next.resolve({ ...mark, id: 'mark-two', note: '新备注' });
    expect(await current).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ marks: [{ id: 'mark-two' }], isSaving: false });
  });
  it('does not apply a confirmation or start another write after an account change', async () => {
    const { api, account, controller } = fixture();
    const held = deferred<ReaderMark>();
    api.create.mockReturnValueOnce(held.promise);
    const pending = controller.create(input);
    account.id = 'account-b';
    held.resolve(mark);
    expect(await pending).toBe(false);
    expect(controller.getSnapshot().marks).toEqual([]);
    expect(await controller.create(input)).toBe(false);
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('rejects a confirmation for a different book and filters unrelated startup marks', async () => {
    const { api, controller } = fixture();
    const other = { ...mark, bookId: 'book-b' };
    controller.seed([mark, other]);
    expect(controller.getSnapshot().marks).toEqual([mark]);
    api.create.mockResolvedValueOnce(other);
    expect(await controller.create(input)).toBe(false);
    expect(controller.getSnapshot().marks).toEqual([mark]);
  });
  it('upserts the same confirmed identity without duplicating a startup record', async () => {
    const { controller } = fixture();
    controller.seed([mark]);
    expect(await controller.create(input)).toBe(true);
    expect(controller.getSnapshot().marks).toEqual([mark]);
  });
  it('preserves a mark on deletion failure and prevents duplicate pending deletes', async () => {
    const { api, controller } = fixture();
    controller.seed([mark]);
    const held = deferred<void>();
    api.remove.mockReturnValueOnce(held.promise);
    const first = controller.remove(mark);
    await controller.remove(mark);
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().deletingIds).toEqual([mark.id]);
    held.reject(new Error('删除断线'));
    await first;
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], deletingIds: [], error: '删除断线' });
    await controller.remove(mark);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], deletingIds: [], error: null });
  });
  it('ignores an old delete error after reset and cannot delete another book mark', async () => {
    const { api, controller } = fixture();
    controller.seed([mark]);
    const held = deferred<void>();
    api.remove.mockReturnValueOnce(held.promise);
    const previous = controller.remove(mark);
    controller.reset();
    controller.seed([{ ...mark, id: 'new-mark' }]);
    held.reject(new Error('旧错误'));
    await previous;
    expect(controller.getSnapshot()).toMatchObject({ marks: [{ id: 'new-mark' }], error: null });
    await controller.remove({ ...mark, bookId: 'book-b' });
    expect(api.remove).toHaveBeenCalledTimes(1);
  });
});

describe('reader mark list recovery and reconciliation', () => {
  it('distinguishes an empty confirmed list from an initial load failure', async () => {
    const { api, controller } = fixture();
    api.load.mockRejectedValueOnce(new Error('加载断线')).mockResolvedValueOnce([]);
    expect(await controller.load()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], hasLoaded: false, isLoading: false, loadError: '加载断线' });
    expect(await controller.load()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], hasLoaded: true, isLoading: false, loadError: null });
  });

  it('retains the known list on refresh failure and accepts an authoritative retry', async () => {
    const { api, controller } = fixture();
    controller.seed([mark]);
    api.load.mockRejectedValueOnce(new Error('刷新失败')).mockResolvedValueOnce([]);
    expect(await controller.load()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], hasLoaded: true, loadError: '刷新失败' });
    expect(await controller.load()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], hasLoaded: true, loadError: null });
  });

  it('keeps a confirmed note when an older list arrives after its save', async () => {
    const { api, controller } = fixture();
    const held = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(held.promise);
    const pending = controller.load();
    expect(await controller.load()).toBe(false);
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(await controller.create(input)).toBe(true);
    held.resolve([]);
    expect(await pending).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], hasLoaded: true, isLoading: false });
    api.load.mockResolvedValueOnce([]);
    await controller.load();
    expect(controller.getSnapshot().marks).toEqual([]);
  });

  it('does not resurrect a confirmed deletion from an older list', async () => {
    const { api, controller } = fixture();
    controller.seed([mark]);
    const held = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(held.promise);
    const pending = controller.load();
    expect(await controller.remove(mark)).toBe(true);
    held.resolve([mark]);
    expect(await pending).toBe(true);
    expect(controller.getSnapshot().marks).toEqual([]);
  });

  it('does not suppress a failed delete or clear its error on list success', async () => {
    const { api, controller } = fixture();
    controller.seed([mark]);
    const held = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(held.promise);
    api.remove.mockRejectedValueOnce(new Error('删除失败'));
    const pending = controller.load();
    expect(await controller.remove(mark)).toBe(false);
    held.resolve([mark]);
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], error: '删除失败', loadError: null });
  });

  it('does not hide an incomplete initial list behind a successful save', async () => {
    const { api, controller } = fixture();
    api.load.mockRejectedValueOnce(new Error('已有标记未加载'));
    await controller.load();
    await controller.create(input);
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], hasLoaded: false, error: null, loadError: '已有标记未加载' });
  });

  it('aborts a reset load and ignores its late completion while a new request is pending', async () => {
    const { api, controller } = fixture();
    const old = deferred<ReaderMark[]>();
    const next = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const previous = controller.load();
    const signal = api.load.mock.calls[0][1] as AbortSignal;
    controller.reset();
    expect(signal.aborted).toBe(true);
    const pending = controller.load();
    await controller.create(input);
    old.reject(new Error('旧请求失败'));
    expect(await previous).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], isLoading: true, loadError: null });
    next.resolve([]);
    expect(await pending).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ marks: [mark], hasLoaded: true, isLoading: false });
  });

  it('does not apply a late list or issue another request after an account change', async () => {
    const { api, account, controller } = fixture();
    const held = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(held.promise);
    const pending = controller.load();
    account.id = 'account-b';
    held.resolve([mark]);
    expect(await pending).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], hasLoaded: false, isLoading: false });
    expect(await controller.load()).toBe(false);
    expect(api.load).toHaveBeenCalledTimes(1);
  });

  it('filters another book from list responses', async () => {
    const { api, controller } = fixture();
    api.load.mockResolvedValueOnce([mark, { ...mark, id: 'other-mark', bookId: 'book-b' }]);
    await controller.load();
    expect(controller.getSnapshot().marks).toEqual([mark]);
  });

  it('refreshes a loaded snapshot after a peer deletion', async () => {
    const { api, controller } = fixture();
    controller.seed([mark]);
    api.load.mockResolvedValueOnce([]);
    expect(await controller.refresh()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], hasLoaded: true });
  });

  it('coalesces visible-page refreshes during startup into one fresh list', async () => {
    const { api, controller } = fixture();
    const old = deferred<ReaderMark[]>();
    const next = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const pending = controller.load();
    expect(await controller.refresh()).toBe(false);
    expect(await controller.refresh()).toBe(false);
    expect(api.load).toHaveBeenCalledTimes(1);
    old.resolve([mark]);
    await pending;
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().isLoading).toBe(true);
    next.resolve([]);
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ marks: [], isLoading: false }));
    expect(api.load).toHaveBeenCalledTimes(2);
  });

  it('keeps confirmed writes made during the queued refresh', async () => {
    const { api, controller } = fixture();
    const old = deferred<ReaderMark[]>();
    const next = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const pending = controller.load();
    await controller.refresh();
    old.resolve([]);
    await pending;
    await controller.create(input);
    next.resolve([]);
    await vi.waitFor(() => expect(controller.getSnapshot().isLoading).toBe(false));
    expect(controller.getSnapshot().marks).toEqual([mark]);
  });

  it('clears a queued refresh on reset without changing a newer load', async () => {
    const { api, controller } = fixture();
    const old = deferred<ReaderMark[]>();
    const next = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const pending = controller.load();
    await controller.refresh();
    controller.reset();
    const current = controller.load();
    old.resolve([mark]);
    expect(await pending).toBe(false);
    expect(controller.getSnapshot().isLoading).toBe(true);
    next.resolve([]);
    await current;
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ marks: [], isLoading: false });
  });

  it('drops a queued refresh when the account changes', async () => {
    const { api, account, controller } = fixture();
    const held = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(held.promise);
    const pending = controller.load();
    await controller.refresh();
    account.id = 'account-b';
    held.resolve([mark]);
    expect(await pending).toBe(false);
    expect(await controller.refresh()).toBe(false);
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().marks).toEqual([]);
  });

  it('runs the queued visible-page refresh after a failed startup list', async () => {
    const { api, controller } = fixture();
    const old = deferred<ReaderMark[]>();
    api.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce([mark]);
    const pending = controller.load();
    await controller.refresh();
    old.reject(new Error('旧列表网络错误'));
    expect(await pending).toBe(false);
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ marks: [mark], isLoading: false, loadError: null }));
    expect(api.load).toHaveBeenCalledTimes(2);
  });
});
