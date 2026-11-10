import { describe, expect, it, vi } from 'vitest';
import { createPdfDocumentController } from './pdfDocumentController';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const tasks: Array<ReturnType<typeof deferred<string>> & { destroy: ReturnType<typeof vi.fn> }> = [];
  const ready = vi.fn(); const error = vi.fn(); const loading = vi.fn(); const prepare = vi.fn(async (value: string) => value);
  const factory = vi.fn(() => { const task = { ...deferred<string>(), destroy: vi.fn() }; tasks.push(task); return task; });
  const controller = createPdfDocumentController({ load: factory, prepare, onReady: ready, onError: error, onLoading: loading });
  return { controller, tasks, ready, error, loading, prepare, factory };
}
describe('PDF document ownership', () => {
  it('aborts page preparation when a new document supersedes it', async () => {
    const s = setup(); const waiting = deferred<string>(); let signal!: AbortSignal;
    const prepare = vi.fn((_document: string, candidateSignal: AbortSignal) => { signal = candidateSignal; return waiting.promise; });
    const controller = createPdfDocumentController({ load: s.factory, prepare, onReady: s.ready, onError: s.error, onLoading: s.loading });
    const first = controller.load('/old'); s.tasks[0].resolve('old'); await Promise.resolve();
    const next = controller.load('/new'); expect(signal.aborted).toBe(true);
    controller.dispose(); waiting.resolve('late'); s.tasks[1].resolve('new');
    expect(await first).toBe(false); expect(await next).toBe(false); expect(s.ready).not.toHaveBeenCalled();
  });
  it('keeps the visible document alive when a replacement download fails', async () => {
    const s = setup(); const first = s.controller.load('/old'); s.tasks[0].resolve('old'); await first;
    const retry = s.controller.load('/retry'); s.tasks[1].reject(Error('offline')); expect(await retry).toBe(false);
    expect(s.ready.mock.calls).toEqual([['old']]); expect(s.tasks[0].destroy).not.toHaveBeenCalled(); expect(s.tasks[1].destroy).toHaveBeenCalledOnce(); expect(s.error).toHaveBeenCalledWith(expect.any(Error), true);
  });
  it('keeps the visible document when page preparation fails after download', async () => {
    const s = setup(); const first = s.controller.load('/old'); s.tasks[0].resolve('old'); await first;
    s.prepare.mockRejectedValueOnce(Error('corrupt page')); const retry = s.controller.load('/retry'); s.tasks[1].resolve('new'); await retry;
    expect(s.ready).toHaveBeenCalledOnce(); expect(s.tasks[0].destroy).not.toHaveBeenCalled(); expect(s.error).toHaveBeenCalledWith(expect.any(Error), true);
  });
  it('retires the old worker only after the view acknowledges the prepared document', async () => {
    const s = setup(); const first = s.controller.load('/old'); s.tasks[0].resolve('old'); await first;
    const next = s.controller.load('/new'); s.tasks[1].resolve('new'); expect(await next).toBe(true);
    expect(s.tasks[0].destroy).not.toHaveBeenCalled(); s.controller.releaseRetired(); expect(s.tasks[0].destroy).toHaveBeenCalledOnce(); expect(s.tasks[1].destroy).not.toHaveBeenCalled();
    s.controller.dispose(); expect(s.tasks[1].destroy).toHaveBeenCalledOnce(); s.controller.releaseRetired(); expect(s.tasks[0].destroy).toHaveBeenCalledOnce();
  });
  it('coalesces duplicate retries while the same URL is loading', async () => {
    const s = setup(); const first = s.controller.load('/same'); expect(s.controller.load('/same')).toBe(first); expect(s.factory).toHaveBeenCalledOnce(); s.tasks[0].resolve('same'); await first;
  });
  it('ignores an obsolete download and never lets it replace a newer document', async () => {
    const s = setup(); const old = s.controller.load('/old'); const current = s.controller.load('/current'); s.tasks[1].resolve('current'); await current; s.tasks[0].resolve('old'); expect(await old).toBe(false);
    expect(s.ready.mock.calls).toEqual([['current']]); expect(s.tasks[0].destroy).toHaveBeenCalledOnce(); expect(s.error).not.toHaveBeenCalled();
  });
  it('ignores preparation completing after a newer retry started', async () => {
    const s = setup(); const waiting = deferred<string>(); s.prepare.mockImplementationOnce(() => waiting.promise);
    const old = s.controller.load('/old'); s.tasks[0].resolve('old'); await Promise.resolve(); const current = s.controller.load('/current'); s.tasks[1].resolve('current'); await current; waiting.resolve('old'); expect(await old).toBe(false);
    expect(s.ready.mock.calls).toEqual([['current']]);
  });
  it('does not hide the current loading state when an older request rejects', async () => {
    const s = setup(); const old = s.controller.load('/old'); const current = s.controller.load('/current'); s.tasks[0].reject(Error('cancelled')); await old;
    expect(s.loading.mock.calls).toEqual([[true], [true]]); expect(s.error).not.toHaveBeenCalled(); s.tasks[1].resolve('current'); await current; expect(s.loading).toHaveBeenLastCalledWith(false);
  });
  it('cleans up candidate and visible workers once when leaving the reader', async () => {
    const s = setup(); const first = s.controller.load('/old'); s.tasks[0].resolve('old'); await first; const pending = s.controller.load('/next'); s.controller.dispose(); s.controller.dispose(); s.tasks[1].resolve('next'); await pending;
    expect(s.tasks[0].destroy).toHaveBeenCalledOnce(); expect(s.tasks[1].destroy).toHaveBeenCalledOnce(); expect(s.ready).toHaveBeenCalledOnce(); expect(s.error).not.toHaveBeenCalled();
  });
  it('reports an initial failure distinctly from a failure with readable content', async () => {
    const s = setup(); const first = s.controller.load('/bad'); s.tasks[0].reject(Error('bad')); await first; expect(s.error).toHaveBeenCalledWith(expect.any(Error), false);
  });
  it('does not fail a successful retry because old-worker cleanup rejects', async () => {
    const s = setup(); const first = s.controller.load('/old'); s.tasks[0].resolve('old'); await first; s.tasks[0].destroy.mockRejectedValue(Error('cleanup'));
    const next = s.controller.load('/new'); s.tasks[1].resolve('new'); expect(await next).toBe(true); s.controller.releaseRetired(); await Promise.resolve(); expect(s.error).not.toHaveBeenCalled();
  });
});
