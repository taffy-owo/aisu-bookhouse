import { getStoredSession } from '../../../shared/api';
import type { ReaderResource, ReadingProgress } from '../types/reader';
import { decodeChapterScrollRatio, getChapterProgressPercent } from '../utils/chapterScrollPosition';
import type { ReaderViewportAnchor } from '../utils/readerViewportAnchor';
import { getApiServerTime } from '../../../shared/api/serverClock';
import { createReadingProgressTimestamp } from './progressTimestamp';
import { appendChapterHistoryRow, compactChapterHistoryRow, historyRowSize, readChapterHistoryRows,
  removeChapterHistoryRow, type HistoryRow, type PositionRow } from './chapterHistoryStorage';

const STORAGE_KEY = 'aisu-bookhouse:chapter-position-history';
const MAX_BOOKS = 80;
const MAX_CHAPTERS_PER_BOOK = 400;
// localStorage commonly shares a small quota with the rest of the application.
// Keep precise anchors for recent reading without making every future save fail.
const MAX_HISTORY_CHARACTERS = 1_000_000;

export interface ChapterPositionEntry {
  ratio: number;
  updatedAt: string;
  anchor?: ReaderViewportAnchor;
}

type ChapterPositionHistory = Record<string, Record<string, ChapterPositionEntry>>;
type HistorySnapshot = { scope: string; history: ChapterPositionHistory; rows: HistoryRow[]; sources: Map<string, PositionRow> };
// Preserve the reset within this session even if storage rejects the cleanup.
const chapterHistoryResets = new Map<string, number>();
const normalizedRows = new WeakMap<PositionRow, ChapterPositionEntry | null>();
const entryTimes = new WeakMap<ChapterPositionEntry, number>();
let legacyCache: { storage: Storage; scope: string; raw: string | null; history: ChapterPositionHistory } | null = null;

/** A zero progress record without coordinates is an explicit book reset. */
export function reconcileChapterPositionReset(progress: ReadingProgress): void {
  if (!progress.bookId || (progress.readerType !== 'text' && progress.readerType !== 'epub')
    || progress.progressPercent !== 0 || progress.chapterIndex !== undefined
    || progress.chapterHref !== undefined || progress.epubCfi !== undefined
    || progress.pageNumber !== undefined || progress.imageIndex !== undefined) return;
  const resetTime = Date.parse(progress.updatedAt);
  if (!Number.isFinite(resetTime)) return;
  const key = getResetKey(progress.bookId);
  chapterHistoryResets.set(key, Math.max(chapterHistoryResets.get(key) ?? -Infinity, resetTime));
  try {
    const snapshot = readHistorySnapshot();
    const durableReset = snapshot.rows.some(row => row.kind === 'reset' && row.bookId === progress.bookId && row.resetTime >= resetTime);
    if (!durableReset) appendChapterHistoryRow(snapshot.scope, { kind: 'reset', bookId: progress.bookId, resetTime });
    compactHistory(readHistorySnapshot(), progress.bookId);
  } catch {
    // Reads and late writes still honor the in-memory reset timestamp.
  }
}

/** Resume the current local chapter while its durable server sync is still pending. */
export function resolveInitialChapterProgress(resource: ReaderResource, server: ReadingProgress, pending: ReadingProgress | null): ReadingProgress {
  if ((resource.readerType !== 'text' && resource.readerType !== 'epub') || !pending
    || pending.bookId !== server.bookId || pending.readerType !== resource.readerType
    || !pending.positionKey || !Number.isInteger(pending.chapterIndex)
    || pending.pageNumber !== undefined || pending.imageIndex !== undefined
    || decodeChapterScrollRatio(pending.epubCfi) === null) return server;
  const chapter = resource.toc.find(item => item.index === pending.chapterIndex);
  if (!chapter || chapter.positionKey !== pending.positionKey) return server;
  const localTime = Date.parse(pending.updatedAt);
  const serverTime = Date.parse(server.updatedAt);
  if (!Number.isFinite(localTime) || localTime > getApiServerTime() + 300_000
    || (Number.isFinite(serverTime) && localTime <= serverTime)) return server;
  const percent = getChapterProgressPercent(pending.chapterIndex!, resource.chapterCount,
    decodeChapterScrollRatio(pending.epubCfi)!, resource.toc.map(item => item.progressWeight));
  // Keep the local chapter/anchor, but discard a percentage from an older catalog.
  return percent === pending.progressPercent ? pending : { ...pending, progressPercent: percent };
}

export function readChapterPosition(bookId: string, chapterIndex: number, positionKey?: string): ChapterPositionEntry | null {
  const history = readHistory();
  const entry = history[bookId]?.[positionKey ? `chapter:${positionKey}` : String(normalizeChapterIndex(chapterIndex))];
  if (!entry || !Number.isFinite(entry.ratio) || typeof entry.updatedAt !== 'string') {
    return null;
  }

  return cloneEntry(entry);
}

export function saveChapterPosition(bookId: string, chapterIndex: number, ratio: number, updatedAt = createReadingProgressTimestamp(undefined, bookId), positionKey?: string, anchor?: ReaderViewportAnchor | null): void {
  if (!bookId || !Number.isFinite(Date.parse(updatedAt)) || typeof window === 'undefined') return;
  // A stable chapter key survives reordering and isolates replacement editions.
  // Known chapters deliberately do not reuse unidentifiable legacy index entries.
  const normalizedChapterIndex = positionKey ? `chapter:${positionKey}` : String(normalizeChapterIndex(chapterIndex));
  const safeAnchor = normalizeAnchor(anchor);
  try {
    const snapshot = readHistorySnapshot();
    const time = Date.parse(updatedAt), resetTime = chapterHistoryResets.get(getResetKey(bookId, snapshot.scope));
    if (resetTime !== undefined && time <= resetTime) return;
    const previous = snapshot.history[bookId]?.[normalizedChapterIndex];
    if (previous && Date.parse(previous.updatedAt) > time) return;
    const entry = { ratio: clampRatio(ratio), updatedAt, ...(safeAnchor ? { anchor: safeAnchor } : {}) };
    appendChapterHistoryRow(snapshot.scope, { kind: 'position', bookId, chapterKey: normalizedChapterIndex, entry });
    // Re-read after persisting. Another process may have saved a different
    // chapter between our snapshot and write; its immutable row must survive.
    compactHistory(readHistorySnapshot(), bookId, normalizedChapterIndex);
  } catch {
    // Private/hardened browser modes may reject storage. The server-side
    // current position still works; only per-chapter history is unavailable.
  }
}

/** An acknowledged local anchor remains useful; a newer remote move always wins. */
export function resolveChapterAnchor(local: ChapterPositionEntry | null, ratio: number, server?: { chapterIndex?: number; updatedAt: string }, chapterIndex?: number): ReaderViewportAnchor | null {
  if (!local?.anchor || Math.abs(local.ratio - ratio) > 0.000001) return null;
  const localTime = Date.parse(local.updatedAt);
  const serverTime = server && server.chapterIndex === chapterIndex ? Date.parse(server.updatedAt) : Number.NaN;
  if (!Number.isFinite(localTime) || (Number.isFinite(serverTime) && localTime < serverTime)) return null;
  return local.anchor;
}

export function resolveChapterPosition({
  chapterIndex,
  localPosition,
  serverChapterIndex,
  serverRatio,
  serverUpdatedAt,
}: {
  chapterIndex: number;
  localPosition: ChapterPositionEntry | null;
  serverChapterIndex?: number;
  serverRatio: number | null;
  serverUpdatedAt?: string;
}): number {
  if (serverChapterIndex !== chapterIndex || serverRatio === null) {
    return localPosition?.ratio ?? 0;
  }

  if (!localPosition) {
    return clampRatio(serverRatio);
  }

  const localTime = Date.parse(localPosition.updatedAt);
  const serverTime = serverUpdatedAt ? Date.parse(serverUpdatedAt) : Number.NaN;
  return Number.isFinite(localTime) && (!Number.isFinite(serverTime) || localTime > serverTime)
    ? localPosition.ratio
    : clampRatio(serverRatio);
}

function readHistory(): ChapterPositionHistory {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    return readHistorySnapshot().history;
  } catch {
    return {};
  }
}

/** Detached projection used by the reader and its browser verification fixture. */
export function readChapterPositionHistory(): ChapterPositionHistory {
  return Object.fromEntries(Object.entries(readHistory()).map(([bookId, entries]) =>
    [bookId, Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, cloneEntry(entry)]))]));
}

function cloneEntry(entry: ChapterPositionEntry): ChapterPositionEntry {
  return { ...entry, ...(entry.anchor ? { anchor: { ...entry.anchor,
    ...(entry.anchor.sourceContext ? { sourceContext: { ...entry.anchor.sourceContext } } : {}) } } : {}) };
}

function chapterLocation(bookId: string, chapterKey: string): string {
  return JSON.stringify([bookId, chapterKey]);
}

function readHistorySnapshot(): HistorySnapshot {
  const scope = getStorageKey();
  const storage = window.localStorage, raw = storage.getItem(scope);
  if (!legacyCache || legacyCache.storage !== storage || legacyCache.scope !== scope || legacyCache.raw !== raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw ?? '{}'); } catch { parsed = {}; }
    legacyCache = { storage, scope, raw, history: normalizeHistory(parsed) };
  }
  // Each projection owns its maps; normalized entries remain immutable inside
  // the cache. Public reads detach their anchors before returning them.
  const history = Object.fromEntries(Object.entries(legacyCache.history).map(([bookId, entries]) => [bookId, { ...entries }]));
  const rows = readChapterHistoryRows(scope), sources = new Map<string, PositionRow>();
  for (const row of rows) {
    if (row.kind === 'reset') {
      const key = getResetKey(row.bookId, scope);
      chapterHistoryResets.set(key, Math.max(chapterHistoryResets.get(key) ?? -Infinity, row.resetTime));
      continue;
    }
    if (!normalizedRows.has(row)) normalizedRows.set(row, normalizeEntry(row.entry));
    const entry = normalizedRows.get(row);
    if (!entry) continue;
    const previous = history[row.bookId]?.[row.chapterKey], location = chapterLocation(row.bookId, row.chapterKey);
    const source = sources.get(location);
    const time = previous ? entryTime(entry) - entryTime(previous) : 1;
    if (previous && (time < 0 || (time === 0 && source && (source.order > row.order
      || (source.order === row.order && source.key > row.key))))) continue;
    (history[row.bookId] ??= {})[row.chapterKey] = entry;
    sources.set(location, row);
  }
  for (const [bookId, chapters] of Object.entries(history)) {
    const resetTime = chapterHistoryResets.get(getResetKey(bookId, scope));
    if (resetTime === undefined) continue;
    for (const [chapterKey, entry] of Object.entries(chapters)) {
      if (entryTime(entry) <= resetTime) delete chapters[chapterKey];
    }
    if (!Object.keys(chapters).length) delete history[bookId];
  }
  return { scope, history, rows, sources };
}

function compactHistory(snapshot: HistorySnapshot, currentBookId: string, currentChapterKey?: string): void {
  const { scope, rows, sources } = snapshot;
  const history = pruneBooks(Object.fromEntries(Object.entries(snapshot.history)
    .map(([bookId, chapters]) => [bookId, pruneEntries(chapters, MAX_CHAPTERS_PER_BOOK)])), MAX_BOOKS);
  const plans = Object.entries(history).flatMap(([bookId, chapters]) => Object.entries(chapters)
    .map(([chapterKey, entry]) => ({ bookId, chapterKey, entry, source: sources.get(chapterLocation(bookId, chapterKey)), removed: false, compacted: false })))
    .sort((left, right) => entryTime(left.entry) - entryTime(right.entry));
  const base: ChapterPositionHistory = {};
  for (const plan of plans) if (!plan.source) (base[plan.bookId] ??= {})[plan.chapterKey] = plan.entry;

  // Keep one durable reset for each retained book and the latest reset books.
  // Older, evicted books will reconcile their authoritative reset on startup.
  const resets = new Map<string, HistoryRow>();
  for (const row of rows) {
    if (row.kind !== 'reset') continue;
    const previous = resets.get(row.bookId);
    if (!previous || (previous.kind === 'reset' && row.resetTime > previous.resetTime)
      || (previous.kind === 'reset' && row.resetTime === previous.resetTime && row.order > previous.order)) resets.set(row.bookId, row);
  }
  const recentResets = [...resets.values()].sort((a, b) => (b.kind === 'reset' ? b.resetTime : 0) - (a.kind === 'reset' ? a.resetTime : 0)).slice(0, MAX_BOOKS);
  const resetKeys = new Set(recentResets.map(row => row.key));
  for (const [bookId, row] of resets) if (bookId === currentBookId || history[bookId]) resetKeys.add(row.key);
  let length = scope.length + JSON.stringify(base).length
    + rows.filter(row => resetKeys.has(row.key)).reduce((total, row) => total + historyRowSize(row), 0)
    + plans.reduce((total, plan) => total + (plan.source ? historyRowSize(plan.source) : 0), 0);
  for (const plan of plans) {
    if (length <= MAX_HISTORY_CHARACTERS) break;
    if (!plan.entry.anchor || (plan.bookId === currentBookId && plan.chapterKey === currentChapterKey)) continue;
    length -= JSON.stringify(plan.entry.anchor).length + ',"anchor":'.length;
    const { ratio, updatedAt } = plan.entry;
    plan.entry = { ratio, updatedAt };
    plan.compacted = true;
    if (plan.source) length += ':compact'.length;
    else base[plan.bookId][plan.chapterKey] = plan.entry;
  }
  const baseCounts = new Map(Object.entries(base).map(([bookId, chapters]) => [bookId, Object.keys(chapters).length]));
  let baseBooks = baseCounts.size;
  for (const plan of plans) {
    if (length <= MAX_HISTORY_CHARACTERS) break;
    if (plan.bookId === currentBookId && plan.chapterKey === currentChapterKey) continue;
    if (plan.source) {
      length -= historyRowSize({ ...plan.source, entry: plan.entry,
        key: plan.compacted ? plan.source.key + ':compact' : plan.source.key });
    } else {
      const count = baseCounts.get(plan.bookId)!;
      length -= JSON.stringify(plan.chapterKey).length + 1 + JSON.stringify(plan.entry).length + (count > 1 ? 1 : 0);
      delete base[plan.bookId][plan.chapterKey];
      baseCounts.set(plan.bookId, count - 1);
      if (count === 1) {
        length -= JSON.stringify(plan.bookId).length + 3 + (baseBooks > 1 ? 1 : 0);
        delete base[plan.bookId];
        baseBooks--;
      }
    }
    plan.removed = true;
  }

  // The old map is now a read-only source for legacy entries. It never absorbs
  // journal rows, so competing checkpoints cannot erase another writer's save.
  const serialized = JSON.stringify(base);
  if (window.localStorage.getItem(scope) !== serialized) window.localStorage.setItem(scope, serialized);
  const keep = new Map(plans.filter(plan => !plan.removed && plan.source).map(plan => [plan.source!.key, plan]));
  for (const row of rows) {
    if (row.kind === 'reset') {
      if (!resetKeys.has(row.key)) removeChapterHistoryRow(row);
      continue;
    }
    const plan = keep.get(row.key);
    if (!plan) removeChapterHistoryRow(row);
    else if (JSON.stringify(plan.entry) !== JSON.stringify(row.entry)) {
      compactChapterHistoryRow(row, plan.entry);
      removeChapterHistoryRow(row);
    }
  }
}

function normalizeHistory(value: unknown): ChapterPositionHistory {
  if (!isRecord(value)) {
    return {};
  }

  const history: ChapterPositionHistory = {};
  for (const [bookId, rawEntries] of Object.entries(value)) {
    if (!isRecord(rawEntries)) {
      continue;
    }

    const entries: Record<string, ChapterPositionEntry> = {};
    for (const [chapterIndex, rawEntry] of Object.entries(rawEntries)) {
      const entry = normalizeEntry(rawEntry);
      if (entry) entries[chapterIndex] = entry;
    }
    if (Object.keys(entries).length > 0) {
      history[bookId] = entries;
    }
  }
  return history;
}

function normalizeEntry(value: unknown): ChapterPositionEntry | null {
  if (!isRecord(value) || typeof value.ratio !== 'number' || !Number.isFinite(value.ratio)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  const anchor = normalizeAnchor(value.anchor);
  return { ratio: clampRatio(value.ratio), updatedAt: value.updatedAt, ...(anchor ? { anchor } : {}) };
}

function entryTime(entry: ChapterPositionEntry): number {
  let time = entryTimes.get(entry);
  if (time === undefined) {
    time = Date.parse(entry.updatedAt);
    entryTimes.set(entry, time);
  }
  return time;
}

function normalizeAnchor(value: unknown): ReaderViewportAnchor | null {
  if (!isRecord(value) || !Number.isInteger(value.blockIndex) || (value.blockIndex as number) < 0
    || typeof value.blockText !== 'string' || value.blockText.length > 64
    || typeof value.offsetRatio !== 'number' || !Number.isFinite(value.offsetRatio) || value.offsetRatio < 0 || value.offsetRatio > 1
    || typeof value.viewportOffset !== 'number' || !Number.isFinite(value.viewportOffset) || Math.abs(value.viewportOffset) > 10_000) return null;
  const anchor: ReaderViewportAnchor = {
    blockIndex: value.blockIndex as number, blockText: value.blockText, offsetRatio: value.offsetRatio, viewportOffset: value.viewportOffset,
  };
  if (value.boundary === 'start' || value.boundary === 'end') anchor.boundary = value.boundary;
  if (Number.isInteger(value.sourceOffset) && (value.sourceOffset as number) >= 0
    && typeof value.sourceViewportOffset === 'number' && Number.isFinite(value.sourceViewportOffset) && Math.abs(value.sourceViewportOffset) <= 10_000) {
    anchor.sourceOffset = value.sourceOffset as number;
    anchor.sourceViewportOffset = value.sourceViewportOffset;
    if (typeof value.sourceSignature === 'string' && /^\d{1,12}:[0-9a-f]{16}$/.test(value.sourceSignature)) anchor.sourceSignature = value.sourceSignature;
    if (isRecord(value.sourceContext) && typeof value.sourceContext.before === 'string' && value.sourceContext.before.length <= 96
      && typeof value.sourceContext.after === 'string' && value.sourceContext.after.length <= 96) {
      anchor.sourceContext = { before: value.sourceContext.before, after: value.sourceContext.after };
    }
  }
  return anchor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStorageKey(): string {
  const userId = getStoredSession()?.id;
  return userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;
}

function getResetKey(bookId: string, storageKey = getStorageKey()): string {
  return JSON.stringify([storageKey, bookId]);
}

function pruneEntries(entries: Record<string, ChapterPositionEntry>, limit: number): Record<string, ChapterPositionEntry> {
  if (Object.keys(entries).length <= limit) return entries;
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, left], [, right]) => entryTime(right) - entryTime(left))
      .slice(0, limit),
  );
}

function pruneBooks(history: ChapterPositionHistory, limit: number): ChapterPositionHistory {
  if (Object.keys(history).length <= limit) return history;
  return Object.fromEntries(
    Object.entries(history)
      .map(([bookId, entries]) => ({ bookId, entries, time: getLatestTimestamp(entries) }))
      .sort((left, right) => right.time - left.time)
      .slice(0, limit)
      .map(({ bookId, entries }) => [bookId, entries]),
  );
}

function getLatestTimestamp(entries: Record<string, ChapterPositionEntry>): number {
  return Math.max(0, ...Object.values(entries).map((entry) => entryTime(entry) || 0));
}

function normalizeChapterIndex(chapterIndex: number): number {
  return Math.max(1, Math.floor(chapterIndex) || 1);
}

function clampRatio(ratio: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
}
