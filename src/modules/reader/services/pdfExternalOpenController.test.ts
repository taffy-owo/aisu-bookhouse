import { describe, expect, it, vi } from 'vitest';
import { createPdfExternalOpenController } from './pdfExternalOpenController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function popupFixture() { return { closed: false, close: vi.fn(), navigate: vi.fn() }; }

describe('PDF new-window access renewal', () => {
  it('opens during the gesture, waits for fresh access and keeps the navigated window on disposal', async () => {
    const popup = popupFixture(), fresh = deferred<string>();
    const open = vi.fn(() => popup);
    const controller = createPdfExternalOpenController('/old', () => fresh.promise, open);
    const pending = controller.open();
    expect(open).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().isOpening).toBe(true);
    expect(popup.navigate).not.toHaveBeenCalled();
    fresh.resolve('/renewed');
    await pending;
    expect(popup.navigate).toHaveBeenCalledWith('/renewed');
    controller.reset();
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('does not create duplicate windows or renewals while one action is pending', async () => {
    const fresh = deferred<string>(), popup = popupFixture();
    const open = vi.fn(() => popup), refresh = vi.fn(() => fresh.promise);
    const controller = createPdfExternalOpenController('/old', refresh, open);
    const first = controller.open();
    await controller.open();
    expect(open).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    fresh.resolve('/new');
    await first;
    expect(controller.getSnapshot()).toEqual({ error: '', isOpening: false });
  });

  it('closes the blank window after a failed renewal and permits another attempt', async () => {
    const first = popupFixture(), second = popupFixture();
    const refresh = vi.fn().mockRejectedValueOnce(new Error('权限请求失败')).mockResolvedValueOnce('/fresh');
    const open = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const controller = createPdfExternalOpenController('/old', refresh, open);
    await controller.open();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.navigate).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({ error: '权限请求失败', isOpening: false });
    await controller.open();
    expect(second.navigate).toHaveBeenCalledWith('/fresh');
    expect(controller.getSnapshot()).toEqual({ error: '', isOpening: false });
  });

  it('shows a blocked-window error without making an access request', async () => {
    const refresh = vi.fn();
    const controller = createPdfExternalOpenController('/old', refresh, () => null);
    await controller.open();
    expect(controller.getSnapshot().error).toContain('浏览器阻止了新窗口');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('closes a pending window and aborts its URL request on reader disposal', async () => {
    const fresh = deferred<string>(), popup = popupFixture();
    const refresh = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(false); return fresh.promise; });
    const controller = createPdfExternalOpenController('/old', refresh, () => popup);
    const pending = controller.open();
    controller.reset();
    expect(refresh.mock.calls[0][0].aborted).toBe(true);
    expect(popup.close).toHaveBeenCalledTimes(1);
    fresh.resolve('/late');
    await pending;
    expect(popup.navigate).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({ error: '', isOpening: false });
  });

  it('respects a window the user closes before renewal finishes', async () => {
    const fresh = deferred<string>(), popup = popupFixture();
    const controller = createPdfExternalOpenController('/old', () => fresh.promise, () => popup);
    const pending = controller.open();
    popup.closed = true;
    fresh.resolve('/fresh');
    await pending;
    expect(popup.navigate).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({ error: '', isOpening: false });
  });
});
