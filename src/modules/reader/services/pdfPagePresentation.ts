import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { buildPdfPageReflow } from './pdfTextReflow';
import type { PdfTextItemLike } from './pdfTextReflow';
import type { PdfPageSize } from './pdfReaderLayout';

export type PdfCanvasPresentation = {
  canvas: HTMLCanvasElement;
  pageWidth: number;
  displayWidth: number;
  displayHeight: number;
  size: PdfPageSize;
};
export type PdfPagePresentation = {
  pageNumber: number;
  size: PdfPageSize;
  paragraphs?: string[];
  frame?: PdfCanvasPresentation;
};

// A retry warms only the selected page and the pages actually on screen.
// The old worker's destruction releases these buffers, including cancelled loads.
const preparedPages = new WeakMap<PDFDocumentProxy, ReadonlyMap<number, PdfPagePresentation>>();
export function getPreparedPdfPage(document: PDFDocumentProxy, pageNumber: number) {
  return preparedPages.get(document)?.get(pageNumber);
}
export function disposePdfPresentation(presentation: PdfPagePresentation) {
  if (presentation.frame) {
    presentation.frame.canvas.width = 0;
    presentation.frame.canvas.height = 0;
  }
}
export function releasePreparedPdfPages(document: PDFDocumentProxy) {
  preparedPages.get(document)?.forEach(disposePdfPresentation);
  preparedPages.delete(document);
}
export function setPreparedPdfPages(document: PDFDocumentProxy, pages: ReadonlyMap<number, PdfPagePresentation>) {
  preparedPages.get(document)?.forEach((page, number) => { if (pages.get(number) !== page) disposePdfPresentation(page); });
  preparedPages.set(document, pages);
}

export async function readPdfPageText(page: PDFPageProxy) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PdfTextItemLike[] = content.items.flatMap((item) => 'str' in item ? [{
    dir: item.dir, height: item.height, str: item.str, transform: item.transform.map(Number), width: item.width,
  }] : []);
  const result = buildPdfPageReflow(items, page.view);
  return { size: { width: viewport.width, height: viewport.height }, paragraphs: result.characterCount >= 80 ? result.paragraphs : [] };
}

function requireActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('PDF rendering cancelled', 'AbortError');
}

/** Render into a separate bitmap; changing size must never erase the readable canvas. */
export async function renderPdfPageFrame(page: PDFPageProxy, pageWidth: number, signal?: AbortSignal, createCanvas = () => document.createElement('canvas')): Promise<PdfCanvasPresentation> {
  requireActive(signal);
  const base = page.getViewport({ scale: 1 });
  if (![pageWidth, base.width, base.height].every((value) => Number.isFinite(value) && value > 0)) throw new Error('PDF 页面尺寸无效');
  const viewport = page.getViewport({ scale: pageWidth / base.width });
  if (![viewport.width, viewport.height].every((value) => Number.isFinite(value) && value > 0)) throw new Error('PDF 页面尺寸无效');
  const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / Math.max(1, viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height);
  const canvas = createCanvas();
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas unavailable');
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  let task: ReturnType<PDFPageProxy['render']> | undefined;
  const cancel = () => task?.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    requireActive(signal);
    task = page.render({ canvas, canvasContext: context, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0], viewport });
    await task.promise;
    requireActive(signal);
    return { canvas, pageWidth, displayWidth: Math.floor(viewport.width), displayHeight: Math.floor(viewport.height), size: { width: base.width, height: base.height } };
  } catch (error) {
    canvas.width = 0; canvas.height = 0;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** Copying a finished bitmap is synchronous, so no intermediate blank frame is painted. */
export function paintPdfPageFrame(canvas: HTMLCanvasElement, frame: PdfCanvasPresentation) {
  if (!frame.canvas.width || !frame.canvas.height) throw new Error('PDF 页面尚未准备完成');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas unavailable');
  canvas.width = frame.canvas.width;
  canvas.height = frame.canvas.height;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  context.drawImage(frame.canvas, 0, 0);
}

export async function preparePdfPage(document: PDFDocumentProxy, pageNumber: number, mode: 'page' | 'text', canvasWidth: (size: PdfPageSize) => number, signal: AbortSignal, requireText = false): Promise<PdfPagePresentation> {
  requireActive(signal);
  const page = await document.getPage(pageNumber);
  requireActive(signal);
  const viewport = page.getViewport({ scale: 1 });
  const size = { width: viewport.width, height: viewport.height };
  let paragraphs: string[] | undefined;
  if (mode === 'text') {
    try { paragraphs = (await readPdfPageText(page)).paragraphs; }
    catch (error) { requireActive(signal); if (requireText) throw error; paragraphs = []; }
    requireActive(signal);
    if (paragraphs.length) return { pageNumber, size, paragraphs };
    if (requireText) throw new Error('PDF 文本暂时不可用，请重试；当前页面已保留。');
  }
  const frame = await renderPdfPageFrame(page, canvasWidth(size), signal);
  return { pageNumber, size, paragraphs, frame };
}

/** Let queued scroll/resize intents settle before publishing a prepared document. */
export function waitForPdfPresentationFrame(signal: AbortSignal): Promise<void> {
  requireActive(signal);
  return new Promise((resolve, reject) => {
    const frame = window.requestAnimationFrame(() => { signal.removeEventListener('abort', cancel); resolve(); });
    const cancel = () => { window.cancelAnimationFrame(frame); reject(new DOMException('PDF rendering cancelled', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
