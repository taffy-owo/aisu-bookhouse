import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReaderFavoriteController } from './readerFavoriteController';

const book = { id: 'book-a', favorite: false, isOwned: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  vi.useFakeTimers();
  const account = { id: 'owner-a' };
  const save = vi.fn().mockResolvedValue({ ...book, favorite: true });
  const controller = createReaderFavoriteController(book, save, () => account.id);
  return { account, save, controller };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('reader favorite confirmation lifecycle', () => {
  it('allows one pending mutation and changes the favorite only after confirmation', async () => {
    const { save, controller } = fixture();
    const held = deferred<typeof book>();
    save.mockReturnValueOnce(held.promise);
    const pending = controller.toggle();
    expect(controller.getSnapshot()).toMatchObject({ favorite: false, isSaving: true });
    expect(await controller.toggle()).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    held.resolve({ ...book, favorite: true });
    expect(await pending).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ favorite: true, isSaving: false });
  });
  it('keeps the confirmed favorite on failure and retries that same intended transition', async () => {
    const { save, controller } = fixture();
    save.mockRejectedValueOnce(new Error('离线'));
    expect(await controller.toggle()).toBe(false);
    expect(controller.getSnapshot()).toEqual({ favorite: false, isSaving: false, message: '离线' });
    expect(await controller.toggle()).toBe(true);
    expect(save.mock.calls).toEqual([['book-a', true], ['book-a', true]]);
    save.mockResolvedValueOnce(book);
    expect(await controller.toggle()).toBe(true);
    expect(save).toHaveBeenLastCalledWith('book-a', false);
  });
  it('gives the next message a full lifetime instead of letting the previous timer erase it', async () => {
    const { save, controller } = fixture();
    await controller.toggle();
    vi.advanceTimersByTime(1250);
    save.mockRejectedValueOnce(new Error('第二次失败'));
    await controller.toggle();
    vi.advanceTimersByTime(1100);
    expect(controller.getSnapshot().message).toBe('第二次失败');
    vi.advanceTimersByTime(1100);
    expect(controller.getSnapshot().message).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans the message timer on disposal', async () => {
    const { controller } = fixture();
    await controller.toggle();
    expect(vi.getTimerCount()).toBe(1);
    controller.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getSnapshot()).toEqual({ favorite: false, isSaving: false, message: '' });
  });
  it('ignores a late confirmation after reset while a new save is still pending', async () => {
    const { save, controller } = fixture();
    const old = deferred<typeof book>();
    const next = deferred<typeof book>();
    save.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const previous = controller.toggle();
    controller.reset();
    const current = controller.toggle();
    old.resolve({ ...book, favorite: true });
    expect(await previous).toBe(false);
    expect(controller.getSnapshot()).toEqual({ favorite: false, isSaving: true, message: '' });
    expect(vi.getTimerCount()).toBe(0);
    next.resolve({ ...book, favorite: true });
    expect(await current).toBe(true);
  });
  it('rejects writes and late errors after switching accounts', async () => {
    const { save, account, controller } = fixture();
    const held = deferred<typeof book>();
    save.mockReturnValueOnce(held.promise);
    const pending = controller.toggle();
    account.id = 'owner-b';
    held.reject(new Error('旧账号错误'));
    expect(await pending).toBe(false);
    expect(await controller.toggle()).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().message).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a response belonging to a different book', async () => {
    const { save, controller } = fixture();
    save.mockResolvedValueOnce({ ...book, id: 'book-b', favorite: true });
    expect(await controller.toggle()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ favorite: false, isSaving: false, message: '收藏结果与当前图书不一致' });
  });
  it('cannot mutate a public book owned by another account', async () => {
    const { save } = fixture();
    const controller = createReaderFavoriteController({ ...book, isOwned: false }, save, () => 'reader');
    expect(await controller.toggle()).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
