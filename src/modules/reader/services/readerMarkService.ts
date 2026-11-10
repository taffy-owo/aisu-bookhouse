import { notifyReaderContentConflict } from './readerContentConflict';
import { apiRequest, getAccountScope, isBackendApiEnabled } from '../../../shared/api';
import type { ReaderMark, ReaderMarkCreateInput, ReaderMarkPositionInput, ReaderMarkUpdateInput } from '../types/reader';
import { readLocalReaderMarks, writeLocalReaderMarks } from './readerMarkStore';

export type BackendReaderMark = {
  content_version?: string | null;
  position_key?: string | null;
  position_valid?: boolean;
  book_id: string;
  chapter_index: number | null;
  created_at: string;
  epub_cfi: string | null;
  id: string;
  image_index: number | null;
  kind: ReaderMark['kind'];
  label: string;
  note: string;
  page_number: number | null;
  progress_percent: number;
  reader_type: ReaderMark['readerType'];
  updated_at: string;
};

export async function getReaderMarks(bookId: string, signal?: AbortSignal): Promise<ReaderMark[]> {
  if (isBackendApiEnabled()) {
    const marks = await apiRequest<BackendReaderMark[]>(`/books/${bookId}/marks`, { signal });
    return marks.map(mapBackendReaderMark);
  }

  return sortReaderMarks(readLocalReaderMarks(bookId));
}

export async function createReaderMark(bookId: string, input: ReaderMarkCreateInput, signal?: AbortSignal): Promise<ReaderMark> {
  if (isBackendApiEnabled()) {
    const scope = getAccountScope();
    try {
      const mark = await apiRequest<BackendReaderMark>(`/books/${bookId}/marks`, {
        body: JSON.stringify({
          ...(input.positionKey ? { position_key: input.positionKey } : {}),
          ...(input.contentVersion ? { content_version: input.contentVersion } : {}),
          chapter_index: input.chapterIndex ?? null,
          epub_cfi: input.epubCfi ?? null,
          image_index: input.imageIndex ?? null,
          kind: input.kind,
          label: input.label,
          note: input.note ?? '',
          page_number: input.pageNumber ?? null,
          progress_percent: input.progressPercent,
          reader_type: input.readerType,
        }),
        method: 'POST',
        ...(signal ? { signal } : {}),
      });
      return mapBackendReaderMark(mark);
    } catch (error) {
      notifyReaderContentConflict(bookId, error, scope, signal);
      throw error;
    }
  }

  const now = new Date().toISOString();
  const mark: ReaderMark = {
    contentVersion: input.contentVersion,
    positionKey: input.positionKey,
    positionValid: true,
    bookId,
    chapterIndex: input.chapterIndex,
    createdAt: now,
    epubCfi: input.epubCfi,
    id: createLocalReaderMarkId(),
    imageIndex: input.imageIndex,
    kind: input.kind,
    label: input.label,
    note: input.note ?? '',
    pageNumber: input.pageNumber,
    progressPercent: input.progressPercent,
    readerType: input.readerType,
    updatedAt: now,
  };

  writeLocalReaderMarks(bookId, sortReaderMarks([...readLocalReaderMarks(bookId), mark]));
  return mark;
}

export async function updateReaderMark(bookId: string, markId: string, input: ReaderMarkUpdateInput): Promise<ReaderMark> {
  if (isBackendApiEnabled()) {
    const mark = await apiRequest<BackendReaderMark>(`/books/${bookId}/marks/${markId}`, {
      body: JSON.stringify({
        label: input.label,
        note: input.note,
      }),
      method: 'PATCH',
    });
    return mapBackendReaderMark(mark);
  }

  const marks = readLocalReaderMarks(bookId);
  const existingMark = marks.find((mark) => mark.id === markId);

  if (!existingMark) {
    throw new Error('未找到这条书签');
  }

  const updatedMark: ReaderMark = {
    ...existingMark,
    label: input.label ?? existingMark.label,
    note: input.note,
    updatedAt: new Date().toISOString(),
  };

  writeLocalReaderMarks(
    bookId,
    sortReaderMarks(marks.map((mark) => (mark.id === markId ? updatedMark : mark))),
  );
  return updatedMark;
}

export async function relocateReaderMark(bookId: string, markId: string, position: ReaderMarkPositionInput, signal?: AbortSignal): Promise<ReaderMark> {
  if (isBackendApiEnabled()) {
    if (!position.positionKey) throw new Error('当前正文尚未就绪，请稍后再定位。');
    const scope = getAccountScope();
    try {
      const mark = await apiRequest<BackendReaderMark>(`/books/${bookId}/marks/${markId}/position`, {
        method: 'PUT', ...(signal ? { signal } : {}),
        body: JSON.stringify({
          ...(position.contentVersion ? { content_version: position.contentVersion } : {}),
          position_key: position.positionKey, reader_type: position.readerType,
          chapter_index: position.chapterIndex ?? null, image_index: position.imageIndex ?? null,
          page_number: position.pageNumber ?? null, epub_cfi: position.epubCfi ?? null,
          progress_percent: position.progressPercent,
        }),
      });
      return mapBackendReaderMark(mark);
    } catch (error) { notifyReaderContentConflict(bookId, error, scope, signal); throw error; }
  }
  const marks = readLocalReaderMarks(bookId);
  const existing = marks.find((mark) => mark.id === markId);
  if (!existing) throw new Error('未找到这条书签');
  const moved: ReaderMark = {
    ...existing, contentVersion: position.contentVersion, positionKey: position.positionKey, positionValid: true, readerType: position.readerType,
    chapterIndex: position.chapterIndex, imageIndex: position.imageIndex, pageNumber: position.pageNumber,
    epubCfi: position.epubCfi, progressPercent: position.progressPercent, updatedAt: new Date().toISOString(),
  };
  writeLocalReaderMarks(bookId, sortReaderMarks(marks.map((mark) => mark.id === markId ? moved : mark)));
  return moved;
}

export async function deleteReaderMark(bookId: string, markId: string, signal?: AbortSignal): Promise<void> {
  if (isBackendApiEnabled()) {
    await apiRequest<void>(`/books/${bookId}/marks/${markId}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
    return;
  }

  writeLocalReaderMarks(
    bookId,
    readLocalReaderMarks(bookId).filter((mark) => mark.id !== markId),
  );
}

export function mapBackendReaderMark(mark: BackendReaderMark): ReaderMark {
  return {
    ...(mark.content_version ? { contentVersion: mark.content_version } : {}),
    ...(mark.position_key ? { positionKey: mark.position_key } : {}),
    ...(typeof mark.position_valid === 'boolean' ? { positionValid: mark.position_valid } : {}),
    bookId: mark.book_id,
    chapterIndex: mark.chapter_index ?? undefined,
    createdAt: mark.created_at,
    epubCfi: mark.epub_cfi ?? undefined,
    id: mark.id,
    imageIndex: mark.image_index ?? undefined,
    kind: mark.kind,
    label: mark.label,
    note: mark.note,
    pageNumber: mark.page_number ?? undefined,
    progressPercent: mark.progress_percent,
    readerType: mark.reader_type,
    updatedAt: mark.updated_at,
  };
}

function sortReaderMarks(marks: ReaderMark[]): ReaderMark[] {
  return [...marks].sort((left, right) => getReaderMarkSortKey(left).localeCompare(getReaderMarkSortKey(right)));
}

function getReaderMarkSortKey(mark: ReaderMark): string {
  return [
    String(mark.chapterIndex ?? 0).padStart(8, '0'),
    String(mark.imageIndex ?? 0).padStart(8, '0'),
    String(mark.pageNumber ?? 0).padStart(8, '0'),
    mark.createdAt,
  ].join(':');
}

function createLocalReaderMarkId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
