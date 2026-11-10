import { getMediaProgressPercent } from './mediaReadingProgress';

export type PdfFitMode = 'page' | 'width' | 'custom';

export type PdfPageSize = {
  height: number;
  width: number;
};

export const PDF_MIN_ZOOM = 0.5;
export const PDF_MAX_ZOOM = 2.5;

export function clampPdfPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.floor(page) || 1, 1), Math.max(pageCount, 1));
}

export function getPdfProgressPercent(page: number, pageCount: number, hasReadPageEnd = true): number {
  const percent = getMediaProgressPercent(page, pageCount);
  return hasReadPageEnd ? percent : Math.min(99, percent);
}

/** Drawing area after the actual scrollbar gutter and stack padding are removed. */
export function calculatePdfPageWidth({ availableSize, customZoom, fitMode, pageSize }: { availableSize: PdfPageSize; customZoom: number; fitMode: PdfFitMode; pageSize: PdfPageSize | null }): number {
  if (!pageSize || availableSize.width <= 0 || availableSize.height <= 0) return 0;
  const fitPageWidth = Math.floor(Math.min(availableSize.width, availableSize.height * pageSize.width / pageSize.height));
  if (fitMode === 'width') return Math.floor(availableSize.width);
  if (fitMode === 'custom') return Math.round(fitPageWidth * customZoom);
  return fitPageWidth;
}

export function calculatePdfPageZoom(options: { availableSize: PdfPageSize; customZoom: number; fitMode: PdfFitMode; pageSize: PdfPageSize | null }) {
  const fittedWidth = calculatePdfPageWidth({ ...options, fitMode: 'page' });
  const widthFit = calculatePdfPageWidth({ ...options, fitMode: 'width' });
  return {
    scale: fittedWidth > 0 ? calculatePdfPageWidth(options) / fittedWidth : 1,
    maximum: fittedWidth > 0 ? Math.max(PDF_MAX_ZOOM, widthFit / fittedWidth * PDF_MAX_ZOOM) : PDF_MAX_ZOOM,
  };
}

export function stepPdfZoom(current: number, delta: number, maximum = PDF_MAX_ZOOM): number {
  return Math.min(Math.max(current, maximum), Math.max(PDF_MIN_ZOOM, Number((current + delta).toFixed(2))));
}

export function calculatePdfFallbackWidth({ availableSize, pageSize, zoom }: { availableSize: PdfPageSize; pageSize: PdfPageSize; zoom: number }): number {
  const fittedWidth = calculatePdfPageWidth({ availableSize, pageSize, customZoom: 1, fitMode: availableSize.width < 768 ? 'width' : 'page' });
  return Math.round(fittedWidth * zoom);
}
