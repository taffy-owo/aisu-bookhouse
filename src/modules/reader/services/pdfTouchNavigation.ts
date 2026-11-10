/** Leave two lines visible between discrete reading screens. */
export function getPdfScreenStep(scrollTop: number, scrollHeight: number, viewportHeight: number, direction: 1 | -1, lineHeight = 32): number {
  const end = Math.max(0, scrollHeight - viewportHeight);
  const current = Math.min(end, Math.max(0, scrollTop));
  const overlap = Math.min(viewportHeight / 2, Math.max(64, lineHeight * 2));
  return Math.min(end, Math.max(0, current + direction * Math.max(1, viewportHeight - overlap)));
}

/** Reaching the last page is insufficient when its text spans many screens. */
export function isPdfPageEndVisible(pageBottom: number, viewportBottom: number): boolean {
  return Number.isFinite(pageBottom) && Number.isFinite(viewportBottom) && pageBottom <= viewportBottom + 2;
}
