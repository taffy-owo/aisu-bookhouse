import type { Book } from '../../books';

export type BulkSeriesDraft = {
  bookId: string;
  orderText: string;
};

export function createBulkSeriesDrafts(books: Book[]): BulkSeriesDraft[] {
  return books.map((book) => ({
    bookId: book.id,
    orderText: book.seriesOrder === undefined
      ? formatSuggestedOrder(inferSeriesOrder(book.title))
      : String(book.seriesOrder),
  }));
}

export function getCommonSeriesField(books: Book[], field: 'seriesKind' | 'seriesTitle'): string {
  const values = new Set(books.map((book) => book[field]?.trim() ?? '').filter(Boolean));
  return values.size === 1 ? [...values][0] ?? '' : '';
}

export function inferSeriesOrder(title: string): number | null {
  const normalized = title.normalize('NFKC').trim();
  if (/\bprologue\b/i.test(normalized) || /(?:序章|前传|前傳)/u.test(normalized)) {
    return 0;
  }

  const patterns = [
    /第\s*(\d+(?:\.\d+)?)\s*卷/iu,
    /卷\s*(\d+(?:\.\d+)?)/iu,
    /(?:vol(?:ume)?\.?\s*)(\d+(?:\.\d+)?)/iu,
    /第\s*(\d+(?:\.\d+)?)\s*[-~至]\s*\d+(?:\.\d+)?\s*(?:话|話)/u,
    /(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:话|話)/u,
    /(?:话|話)\s*(\d+(?:\.\d+)?)/u,
    /^[A-Za-z][A-Za-z\s_-]*?(\d{1,3})(?=\s|$)/u,
    /(\d+(?:\.\d+)?)\s*$/u,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const value = match?.[1] ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(value)) {
      return value;
    }
  }

  if (/(?:番外|短篇|\bSS\d*\b)/iu.test(normalized)) {
    return 900;
  }

  return null;
}

export function parseBulkSeriesOrder(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const order = Number(normalized);
  return Number.isFinite(order) ? order : null;
}

function formatSuggestedOrder(value: number | null): string {
  return value === null ? '' : String(value);
}
