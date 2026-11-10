import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPreparedPdfPage, paintPdfPageFrame, preparePdfPage, releasePreparedPdfPages, renderPdfPageFrame, setPreparedPdfPages, waitForPdfPresentationFrame } from './pdfPagePresentation';

function canvasFixture() {
  const context = { drawImage: vi.fn() };
  const canvas = { width: 12, height: 34, style: { width: '', height: '' }, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
  return { canvas, context };
}
function pageFixture(width = 600, height = 1800) {
  const task = { promise: Promise.resolve(), cancel: vi.fn() };
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale })),
    getTextContent: vi.fn().mockResolvedValue({ items: [] }), view: [0, 0, width, height], render: vi.fn(() => task),
  } as unknown as PDFPageProxy;
  return { page, task };
}
beforeEach(() => vi.stubGlobal('window', { devicePixelRatio: 2 }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('prepared PDF page ownership and presentation', () => {
  it('does not resize or paint the readable canvas until a complete new frame exists', async () => {
    const { page, task } = pageFixture(); const staging = canvasFixture(); const visible = canvasFixture();
    let finish!: () => void; task.promise = new Promise<void>((resolve) => { finish = resolve; });
    const pending = renderPdfPageFrame(page, 900, undefined, () => staging.canvas);
    expect(visible.canvas.width).toBe(12); expect(visible.context.drawImage).not.toHaveBeenCalled();
    finish(); const frame = await pending;
    paintPdfPageFrame(visible.canvas, frame);
    expect(visible.canvas.width).toBe(staging.canvas.width);
    expect(visible.context.drawImage).toHaveBeenCalledWith(staging.canvas, 0, 0);
    expect(visible.canvas.style).toMatchObject({ width: '100%', height: '100%' });
  });
  it('releases a failed staged bitmap while leaving the readable bitmap untouched', async () => {
    const { page, task } = pageFixture(); const staging = canvasFixture(); const visible = canvasFixture();
    task.promise = Promise.reject(new Error('render failed'));
    await expect(renderPdfPageFrame(page, 600, undefined, () => staging.canvas)).rejects.toThrow('render failed');
    expect(staging.canvas.width).toBe(0); expect(staging.canvas.height).toBe(0);
    expect(visible.canvas.width).toBe(12); expect(visible.canvas.height).toBe(34);
  });
  it('cancels an in-flight staged render when its document is superseded', async () => {
    const { page, task } = pageFixture(); const staging = canvasFixture();
    const controller = new AbortController();
    task.promise = new Promise<void>((_, reject) => task.cancel.mockImplementation(() => reject(new Error('cancelled'))));
    const pending = renderPdfPageFrame(page, 600, controller.signal, () => staging.canvas);
    controller.abort(); await expect(pending).rejects.toThrow('cancelled');
    expect(task.cancel).toHaveBeenCalledOnce(); expect(staging.canvas.width).toBe(0);
  });
  it.each([[600, 1800], [10, 100_000_000], [100_000_000, 10]])('bounds staged bitmap allocation for page %s × %s', async (width, height) => {
    const { page } = pageFixture(width, height); const staging = canvasFixture();
    const frame = await renderPdfPageFrame(page, width, undefined, () => staging.canvas);
    expect(frame.canvas.width * frame.canvas.height).toBeLessThanOrEqual(4_000_000);
    expect(frame.canvas.width).toBeGreaterThan(0); expect(frame.canvas.height).toBeGreaterThan(0);
    expect(Math.max(frame.canvas.width, frame.canvas.height)).toBeLessThanOrEqual(16384);
  });
  it('does not erase the visible canvas when it cannot obtain a drawing context', async () => {
    const { page } = pageFixture(); const staging = canvasFixture(); const visible = canvasFixture();
    const frame = await renderPdfPageFrame(page, 600, undefined, () => staging.canvas);
    vi.mocked(visible.canvas.getContext).mockReturnValue(null);
    expect(() => paintPdfPageFrame(visible.canvas, frame)).toThrow('Canvas unavailable');
    expect(visible.canvas.width).toBe(12); expect(visible.canvas.height).toBe(34);
  });
  it('rejects invalid page geometry before allocating a bitmap', async () => {
    const { page } = pageFixture(Number.POSITIVE_INFINITY, 1800); const create = vi.fn(() => canvasFixture().canvas);
    await expect(renderPdfPageFrame(page, 600, undefined, create)).rejects.toThrow('PDF 页面尺寸无效');
    expect(create).not.toHaveBeenCalled(); expect(page.render).not.toHaveBeenCalled();
  });
  it('owns prepared pages per document and releases them exactly when retired', async () => {
    const first = {} as PDFDocumentProxy; const second = {} as PDFDocumentProxy;
    const a = { pageNumber: 1, size: { width: 600, height: 1800 }, frame: await renderPdfPageFrame(pageFixture().page, 600, undefined, () => canvasFixture().canvas) };
    const b = { pageNumber: 1, size: a.size, frame: await renderPdfPageFrame(pageFixture().page, 600, undefined, () => canvasFixture().canvas) };
    const map = new Map([[1, a]]); setPreparedPdfPages(first, map); setPreparedPdfPages(first, map); setPreparedPdfPages(second, new Map([[1, b]]));
    expect(getPreparedPdfPage(first, 1)).toBe(a); expect(a.frame.canvas.width).toBeGreaterThan(0);
    releasePreparedPdfPages(first); releasePreparedPdfPages(first);
    expect(a.frame.canvas.width).toBe(0); expect(getPreparedPdfPage(first, 1)).toBeUndefined();
    expect(b.frame.canvas.width).toBeGreaterThan(0); releasePreparedPdfPages(second);
  });
  it('keeps a readable text page when renewed text extraction fails instead of silently changing layout', async () => {
    const { page } = pageFixture(); vi.mocked(page.getTextContent).mockRejectedValue(new Error('text unavailable'));
    const document = { getPage: vi.fn().mockResolvedValue(page) } as unknown as PDFDocumentProxy;
    await expect(preparePdfPage(document, 1, 'text', () => 600, new AbortController().signal, true)).rejects.toThrow('text unavailable');
    expect(page.render).not.toHaveBeenCalled();
  });
  it('prepares a scanned-page bitmap when text is unavailable and there is no readable text to preserve', async () => {
    const { page } = pageFixture(); vi.mocked(page.getTextContent).mockRejectedValue(new Error('no text'));
    const staging = canvasFixture(); vi.stubGlobal('document', { createElement: () => staging.canvas });
    const document = { getPage: vi.fn().mockResolvedValue(page) } as unknown as PDFDocumentProxy;
    const prepared = await preparePdfPage(document, 1, 'text', () => 600, new AbortController().signal);
    expect(prepared.paragraphs).toEqual([]); expect(prepared.frame?.canvas.width).toBeGreaterThan(0);
  });
  it('cancels a pending publication frame when leaving a hidden reader', async () => {
    const cancel = vi.fn(); vi.stubGlobal('window', { requestAnimationFrame: () => 12, cancelAnimationFrame: cancel });
    const controller = new AbortController(); const pending = waitForPdfPresentationFrame(controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledWith(12);
  });
});
