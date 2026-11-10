import { describe, expect, it } from 'vitest';
import { calculatePdfFallbackWidth, calculatePdfPageWidth, calculatePdfPageZoom, clampPdfPage, getPdfProgressPercent, stepPdfZoom } from '../services/pdfReaderLayout';

describe('PdfReader layout', () => {
  it('clamps requested pages to the document bounds', () => {
    expect(clampPdfPage(-4, 202)).toBe(1);
    expect(clampPdfPage(18, 202)).toBe(18);
    expect(clampPdfPage(999, 202)).toBe(202);
  });

  it('converts the visible PDF page into persisted book progress', () => {
    expect(getPdfProgressPercent(1, 200)).toBe(1);
    expect(getPdfProgressPercent(100, 200)).toBe(50);
    expect(getPdfProgressPercent(200, 200)).toBe(100);
    expect(getPdfProgressPercent(199, 200)).toBe(99);
  });

  it('fits a portrait page inside the available reading viewport', () => {
    expect(calculatePdfPageWidth({
      availableSize: { height: 852, width: 1352 },
      customZoom: 1,
      fitMode: 'page',
      pageSize: { height: 842, width: 595 },
    })).toBe(602);
  });

  it('uses the reading width only when explicitly requested', () => {
    expect(calculatePdfPageWidth({
      availableSize: { height: 852, width: 1352 },
      customZoom: 1,
      fitMode: 'width',
      pageSize: { height: 842, width: 595 },
    })).toBe(1352);
  });

  it('uses nearly the full phone width', () => {
    expect(calculatePdfPageWidth({
      availableSize: { height: 704, width: 378 },
      customZoom: 1,
      fitMode: 'width',
      pageSize: { height: 842, width: 595 },
    })).toBe(378);
  });
  it.each([{ width: 310, height: 126 }, { width: 200, height: 80 }, { width: 50.5, height: 60.5 }])('fits the entire page inside a short drawing area %j', (availableSize) => {
    const pageSize = { width: 600, height: 840 };
    const width = calculatePdfPageWidth({ availableSize, pageSize, customZoom: 1, fitMode: 'page' });
    expect(width).toBeLessThanOrEqual(availableSize.width);
    expect(width * pageSize.height / pageSize.width).toBeLessThanOrEqual(availableSize.height);
    expect(width).toBeGreaterThan(0);
  });
  it('does not round fractional fit-width space into horizontal overflow', () => {
    expect(calculatePdfPageWidth({ availableSize: { width: 272.5, height: 400 }, pageSize: { width: 600, height: 840 }, customZoom: 1, fitMode: 'width' })).toBe(272);
  });
  it('zooms from the rendered fit-width scale instead of shrinking to the fit-page baseline', () => {
    const options = { availableSize: { width: 1488, height: 760 }, customZoom: 1, fitMode: 'width' as const, pageSize: { width: 600, height: 840 } };
    const before = calculatePdfPageWidth(options);
    const zoom = calculatePdfPageZoom(options);
    const after = calculatePdfPageWidth({ ...options, fitMode: 'custom', customZoom: stepPdfZoom(zoom.scale, 0.1, zoom.maximum) });
    expect(after).toBeGreaterThan(before);
    expect(zoom.maximum).toBeGreaterThan(zoom.scale);
    expect(calculatePdfPageWidth({ ...options, fitMode: 'custom', customZoom: stepPdfZoom(zoom.scale, -0.1, zoom.maximum) })).toBeLessThan(before);
  });
  it('keeps fallback pages independently zoomable beyond the viewport', () => {
    const options = { availableSize: { width: 378, height: 824 }, pageSize: { width: 600, height: 840 } };
    expect(calculatePdfFallbackWidth({ ...options, zoom: 1 })).toBe(378);
    expect(calculatePdfFallbackWidth({ ...options, zoom: 2 })).toBe(756);
  });
  it('fits each fallback page using its own portrait or landscape aspect ratio', () => {
    const availableSize = { width: 1488, height: 760 };
    expect(calculatePdfFallbackWidth({ availableSize, pageSize: { width: 600, height: 840 }, zoom: 1 })).toBe(542);
    expect(calculatePdfFallbackWidth({ availableSize, pageSize: { width: 840, height: 600 }, zoom: 1 })).toBe(1064);
  });
  it('keeps repeated zoom steps bounded and free of decimal drift', () => {
    let zoom = 1;
    for (let i = 0; i < 20; i += 1) zoom = stepPdfZoom(zoom, 0.1);
    expect(zoom).toBe(2.5);
    for (let i = 0; i < 30; i += 1) zoom = stepPdfZoom(zoom, -0.1);
    expect(zoom).toBe(0.5);
  });
  it('allows a gradual zoom-out when resizing reduces the current zoom limit', () => {
    expect(stepPdfZoom(3, -0.1, 2.5)).toBe(2.9);
    expect(stepPdfZoom(3, 0.1, 2.5)).toBe(3);
  });
});
