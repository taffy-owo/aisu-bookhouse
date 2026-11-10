import { describe, expect, it, vi } from 'vitest';
import type { Book } from '../../books';
import { createReaderDownloadController } from './readerDownloadController';

const book = { id: 'book' } as Book;
function deferred() { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe('reader download preparation', () => {
  it('coalesces repeated clicks while preparing and permits a later download', async () => {
    const request = deferred(); const download = vi.fn(() => request.promise);
    const controller = createReaderDownloadController(book.id, download, () => 'account');
    const pending = controller.run(book); await controller.run(book);
    expect(download).toHaveBeenCalledTimes(1); expect(controller.getSnapshot()).toEqual({ error: '', isPreparing: true });
    request.resolve(); await pending;
    expect(controller.getSnapshot().isPreparing).toBe(false);
    await controller.run(book); expect(download).toHaveBeenCalledTimes(2);
  });
  it('shows preparation errors and clears them when retry starts', async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error('ticket failed')).mockResolvedValueOnce(undefined);
    const controller = createReaderDownloadController(book.id, download, () => 'account');
    await controller.run(book); expect(controller.getSnapshot()).toEqual({ error: 'ticket failed', isPreparing: false });
    const retry = controller.run(book); expect(controller.getSnapshot()).toEqual({ error: '', isPreparing: true });
    await retry; expect(controller.getSnapshot().error).toBe('');
  });
  it('aborts on departure and ignores the obsolete response after a new request starts', async () => {
    const old = deferred(), next = deferred();
    const download = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const controller = createReaderDownloadController(book.id, download, () => 'account');
    const first = controller.run(book); const signal = download.mock.calls[0][1] as AbortSignal;
    controller.reset(); expect(signal.aborted).toBe(true);
    const second = controller.run(book); old.reject(new Error('late failure')); await first;
    expect(controller.getSnapshot()).toEqual({ error: '', isPreparing: true });
    next.resolve(); await second; expect(controller.getSnapshot().isPreparing).toBe(false);
  });
  it('isolates book and account changes, including a late failure', async () => {
    let scope = 'one'; const request = deferred(); const download = vi.fn(() => request.promise);
    const controller = createReaderDownloadController(book.id, download, () => scope);
    await controller.run({ ...book, id: 'another' }); expect(download).not.toHaveBeenCalled();
    const pending = controller.run(book); scope = 'two';
    expect(controller.getSnapshot()).toEqual({ error: '', isPreparing: false });
    request.reject(new Error('old account')); await pending; await controller.run(book);
    expect(download).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().error).toBe('');
  });
});
