import type { ReaderTocItem } from '../types/reader';

export function filterReaderTocItems(toc: ReaderTocItem[], query: string): ReaderTocItem[] {
  const normalizedQuery = normalizeLocatorQuery(query);
  if (!normalizedQuery) {
    return toc;
  }

  return toc.filter((item) => {
    const searchableTitle = normalizeLocatorQuery(item.title);
    return searchableTitle.includes(normalizedQuery) || String(item.index).includes(normalizedQuery);
  });
}

export function normalizeRequestedPageIndex(value: string, pageCount: number): number | null {
  const normalized = value.trim().replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  if (!/^\d+$/.test(normalized)) return null;
  const requestedPage = Number(normalized);
  if (!Number.isSafeInteger(requestedPage) || !Number.isSafeInteger(pageCount) || pageCount < 1) {
    return null;
  }

  return Math.min(pageCount, Math.max(1, requestedPage));
}

function normalizeLocatorQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();
}
