import type { ChapterPositionEntry } from './chapterPositionHistory';

type PositionData = { kind: 'position'; bookId: string; chapterKey: string; entry: ChapterPositionEntry };
type ResetData = { kind: 'reset'; bookId: string; resetTime: number };
export type HistoryRow = (PositionData | ResetData) & { key: string; order: number };
export type PositionRow = Extract<HistoryRow, { kind: 'position' }>;
let observedOrder = 0;
let cachedStorage: Storage | null = null;
let cachedPrefix = '';
let cachedRows = new Map<string, { raw: string; row: HistoryRow }>();
const rowSizes = new WeakMap<HistoryRow, number>();

export function chapterHistoryStoragePrefix(scope: string): string {
  return `aisu-bookhouse:chapter-history-v2:${encodeURIComponent(scope)}:`;
}

function data(row: HistoryRow) {
  return row.kind === 'position'
    ? { kind: row.kind, bookId: row.bookId, chapterKey: row.chapterKey, entry: row.entry, order: row.order }
    : { kind: row.kind, bookId: row.bookId, resetTime: row.resetTime, order: row.order };
}

export function historyRowSize(row: HistoryRow): number {
  let size = rowSizes.get(row);
  if (size === undefined) {
    size = row.key.length + JSON.stringify(data(row)).length;
    rowSizes.set(row, size);
  }
  return size;
}

export function readChapterHistoryRows(scope: string): HistoryRow[] {
  const storage = window.localStorage, prefix = chapterHistoryStoragePrefix(scope);
  if (cachedStorage !== storage || cachedPrefix !== prefix) {
    cachedStorage = storage;
    cachedPrefix = prefix;
    cachedRows = new Map();
  }
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => !!key?.startsWith(prefix));
  const rows: HistoryRow[] = [];
  const nextCache = new Map<string, { raw: string; row: HistoryRow }>();
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    // Still read every observed key. A peer can replace/remove rows before its
    // storage event arrives; only unchanged bytes may reuse parsed data.
    const cached = cachedRows.get(key);
    if (cached?.raw === raw) {
      rows.push(cached.row);
      nextCache.set(key, cached);
      continue;
    }
    try {
      const value = JSON.parse(raw) as (PositionData | ResetData) & { order: number };
      if (typeof value.bookId !== 'string' || !value.bookId || !Number.isSafeInteger(value.order) || value.order < 0) continue;
      if (value.kind === 'position') {
        if (typeof value.chapterKey !== 'string' || !value.chapterKey || !value.entry
          || !Number.isFinite(value.entry.ratio) || !Number.isFinite(Date.parse(value.entry.updatedAt))) continue;
      } else if (value.kind !== 'reset' || !Number.isFinite(value.resetTime)) continue;
      observedOrder = Math.max(observedOrder, value.order);
      const row = { ...value, key };
      rows.push(row);
      nextCache.set(key, { raw, row });
    } catch { /* An invalid row must not hide other saved chapters. */ }
  }
  // Evicted rows and a previous account's prose must not accumulate in memory.
  cachedRows = nextCache;
  return rows;
}

export function appendChapterHistoryRow(scope: string, value: PositionData | ResetData): HistoryRow {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  observedOrder = Math.max(Date.now(), observedOrder + 1);
  const row = { ...value, order: observedOrder, key: chapterHistoryStoragePrefix(scope) + id };
  window.localStorage.setItem(row.key, JSON.stringify(data(row)));
  return row;
}

/** Preserve the source order: pruning an anchor is not a new reading event. */
export function compactChapterHistoryRow(row: PositionRow, entry: ChapterPositionEntry): PositionRow {
  const compact = { ...row, key: row.key + ':compact', entry };
  window.localStorage.setItem(compact.key, JSON.stringify(data(compact)));
  return compact;
}

export function removeChapterHistoryRow(row: HistoryRow): void {
  // Keys are immutable. Deleting this observed key never deletes a later save.
  window.localStorage.removeItem(row.key);
}
