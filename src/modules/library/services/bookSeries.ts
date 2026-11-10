import type { Book } from '../../books';

export type BookSeriesInfo = {
  key: string;
  label: string;
  order: number;
  orderLabel: string;
  source: 'manual' | 'single' | 'title';
};

export type BookSeriesShelf = {
  books: Array<Book & { seriesInfo: BookSeriesInfo }>;
  currentIndex: number;
  current: Book & { seriesInfo: BookSeriesInfo };
  label: string;
  nextBook: (Book & { seriesInfo: BookSeriesInfo }) | null;
  previousBook: (Book & { seriesInfo: BookSeriesInfo }) | null;
};

export type BookSeriesVolume = Book & { seriesInfo: BookSeriesInfo };

export type LibraryShelfItem =
  | { book: Book; kind: 'book' }
  | { books: BookSeriesVolume[]; key: string; kind: 'series'; label: string };

const SIDE_STORY_ORDER = 900;
const CHINESE_DIGIT_MAP: Record<string, number> = {
  一: 1,
  七: 7,
  三: 3,
  九: 9,
  二: 2,
  五: 5,
  八: 8,
  六: 6,
  十: 10,
  四: 4,
  两: 2,
  〇: 0,
  零: 0,
};

export function getBookSeriesInfo(book: Book): BookSeriesInfo {
  const manualInfo = getManualSeriesInfo(book);
  if (manualInfo) {
    return manualInfo;
  }

  return parseSeriesTitle(book.title) ?? {
    key: normalizeSeriesKey(book.title),
    label: book.title,
    order: SIDE_STORY_ORDER,
    orderLabel: '单本',
    source: 'single',
  };
}

export function getBookSeriesShelf(currentBook: Book, books: Book[]): BookSeriesShelf | null {
  const currentInfo = getBookSeriesInfo(currentBook);
  if (currentInfo.source === 'single') return null;
  const currentGroup = getLibrarySeriesGroupKey(currentBook, currentInfo);
  const seriesBooks = books
    .map((book) => ({ ...book, seriesInfo: getBookSeriesInfo(book) }))
    .filter((book) => getLibrarySeriesGroupKey(book, book.seriesInfo) === currentGroup)
    .sort(compareSeriesBooks);

  if (seriesBooks.length < 2) {
    return null;
  }

  const currentIndex = Math.max(0, seriesBooks.findIndex((book) => book.id === currentBook.id));
  const current = seriesBooks[currentIndex] ?? { ...currentBook, seriesInfo: currentInfo };
  return {
    books: seriesBooks,
    current,
    currentIndex,
    label: currentInfo.label,
    nextBook: seriesBooks[currentIndex + 1] ?? null,
    previousBook: seriesBooks[currentIndex - 1] ?? null,
  };
}

export function groupBooksForLibraryShelf(books: Book[]): LibraryShelfItem[] {
  const candidates = books.map((book) => ({ book, seriesInfo: getBookSeriesInfo(book) }));
  const groupedCandidates = new Map<string, typeof candidates>();

  for (const candidate of candidates) {
    if (candidate.seriesInfo.source === 'single') continue;
    const groupKey = getLibrarySeriesGroupKey(candidate.book, candidate.seriesInfo);
    const group = groupedCandidates.get(groupKey) ?? [];
    group.push(candidate);
    groupedCandidates.set(groupKey, group);
  }

  const emittedSeries = new Set<string>();
  const items: LibraryShelfItem[] = [];
  for (const candidate of candidates) {
    if (candidate.seriesInfo.source === 'single') {
      items.push({ book: candidate.book, kind: 'book' });
      continue;
    }

    const groupKey = getLibrarySeriesGroupKey(candidate.book, candidate.seriesInfo);
    const group = groupedCandidates.get(groupKey) ?? [];
    if (group.length < 2) {
      items.push({ book: candidate.book, kind: 'book' });
      continue;
    }
    if (emittedSeries.has(groupKey)) continue;

    emittedSeries.add(groupKey);
    items.push({
      books: group
        .map(({ book, seriesInfo }) => ({ ...book, seriesInfo }))
        .sort(compareSeriesBooks),
      key: groupKey,
      kind: 'series',
      label: candidate.seriesInfo.label,
    });
  }

  return items;
}

function parseSeriesTitle(title: string): BookSeriesInfo | null {
  const normalizedTitle = title.trim().replace(/\s+/g, ' ');
  const numericVolumeMatch = normalizedTitle.match(/^(.+?)(?:\s*[-－–—]\s*)?卷\s*([0-9]+)$/i);
  if (numericVolumeMatch?.[1] && numericVolumeMatch[2]) {
    const label = cleanSeriesLabel(numericVolumeMatch[1]);
    const volume = Number(numericVolumeMatch[2]);
    return createSeriesInfo(label, volume, `第 ${volume} 卷`);
  }

  const chineseVolumeMatch = normalizedTitle.match(/^(.+?)\s+第([0-9一二三四五六七八九十〇零两]+)卷$/u);
  if (chineseVolumeMatch?.[1] && chineseVolumeMatch[2]) {
    const label = cleanSeriesLabel(chineseVolumeMatch[1]);
    const volume = parseVolumeNumber(chineseVolumeMatch[2]);
    return createSeriesInfo(label, volume, `第 ${volume} 卷`);
  }

  const sideStoryMatch = normalizedTitle.match(/^(.+?)\s+(SS2|SS|99\.9|短篇)$/iu);
  if (sideStoryMatch?.[1] && sideStoryMatch[2]) {
    const label = cleanSeriesLabel(sideStoryMatch[1]);
    return createSeriesInfo(label, SIDE_STORY_ORDER + getSideStoryOffset(sideStoryMatch[2]), sideStoryMatch[2].toUpperCase());
  }

  return null;
}

function getManualSeriesInfo(book: Book): BookSeriesInfo | null {
  const label = cleanSeriesLabel(book.seriesTitle ?? '');
  if (!label) {
    return null;
  }

  const order = typeof book.seriesOrder === 'number' && Number.isFinite(book.seriesOrder) ? book.seriesOrder : SIDE_STORY_ORDER;
  return createSeriesInfo(label, order, getManualOrderLabel(book.seriesOrder, book.seriesKind), 'manual');
}

function createSeriesInfo(label: string, order: number, orderLabel: string, source: BookSeriesInfo['source'] = 'title'): BookSeriesInfo {
  return {
    key: normalizeSeriesKey(label),
    label,
    order,
    orderLabel,
    source,
  };
}

function compareSeriesBooks(left: Book & { seriesInfo: BookSeriesInfo }, right: Book & { seriesInfo: BookSeriesInfo }): number {
  if (left.seriesInfo.order !== right.seriesInfo.order) {
    return left.seriesInfo.order - right.seriesInfo.order;
  }

  return left.title.localeCompare(right.title, 'zh-CN');
}

function cleanSeriesLabel(value: string): string {
  return value.trim().replace(/\s*[-－–—]\s*$/u, '').trim();
}

function normalizeSeriesKey(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function getLibrarySeriesGroupKey(book: Book, seriesInfo: BookSeriesInfo): string {
  // Explicit series metadata is authoritative. Imported books commonly carry
  // translator credits, alternate spellings, or an uploader name in the
  // author field; requiring an exact author match would split one manually
  // curated series back into several shelf groups.
  if (seriesInfo.source === 'manual') {
    return `manual::${seriesInfo.key}`;
  }

  return `${seriesInfo.key}::${normalizeSeriesKey(book.author || '')}`;
}

function parseVolumeNumber(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (value === '十') {
    return 10;
  }

  const tenIndex = value.indexOf('十');
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : CHINESE_DIGIT_MAP[value[tenIndex - 1] ?? ''] ?? 0;
    const ones = tenIndex === value.length - 1 ? 0 : CHINESE_DIGIT_MAP[value[tenIndex + 1] ?? ''] ?? 0;
    return tens * 10 + ones;
  }

  return CHINESE_DIGIT_MAP[value] ?? SIDE_STORY_ORDER;
}

function getSideStoryOffset(value: string): number {
  const normalizedValue = value.toUpperCase();
  if (normalizedValue === '99.9') {
    return -1;
  }
  if (normalizedValue === 'SS') {
    return 1;
  }
  if (normalizedValue === 'SS2') {
    return 2;
  }
  return 3;
}

function getManualOrderLabel(order: number | undefined, kind: string | undefined): string {
  const normalizedKind = kind?.trim();
  const hasOrder = typeof order === 'number' && Number.isFinite(order);
  if (normalizedKind && hasOrder) {
    return `${normalizedKind} · 第 ${formatSeriesOrder(order)} 卷`;
  }
  if (normalizedKind) {
    return normalizedKind;
  }
  if (hasOrder) {
    return `第 ${formatSeriesOrder(order)} 卷`;
  }
  return '系列内未排序';
}

function formatSeriesOrder(order: number): string {
  return Number.isInteger(order) ? String(order) : String(order);
}
