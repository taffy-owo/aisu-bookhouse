import type { UploadBookMetadata } from './uploadService';
import { getStoredSession } from '../../../shared/api';
import { createRequestId } from '../../../shared/utils/requestId';
import { createManualBookDraftStorage } from './manualBookDraftStorage';
export type { ManualBookDraftStorageIssue } from './manualBookDraftStorage';

const MANUAL_BOOK_DRAFT_STORAGE_KEY = 'aisu-bookhouse:manual-book-draft';

export interface ManualBookDraft {
  author: string;
  content: string;
  description: string;
  publicationStatus: 'ongoing' | 'completed';
  sourceUrl: string;
  tags: string;
  title: string;
  /** Identifies the form snapshot used by an asynchronous source lookup. */
  requestId?: string;
  submittedAt?: string;
}

export interface PreparedManualBook {
  file: File;
  metadata: UploadBookMetadata;
  title: string;
}

export const EMPTY_MANUAL_BOOK_DRAFT: ManualBookDraft = {
  author: '',
  content: '',
  description: '',
  publicationStatus: 'completed',
  sourceUrl: '',
  tags: '',
  title: '',
};

const manualDraftStorage = createManualBookDraftStorage(() => window.localStorage, getManualBookDraftStorageKey);

export function readManualBookDraft(): ManualBookDraft | null {
  return readManualBookDraftState().draft;
}

export function readManualBookDraftState() {
  return manualDraftStorage.read();
}

export function retryManualBookDraftStorage() {
  return manualDraftStorage.retry();
}

export function writeManualBookDraft(draft: ManualBookDraft): boolean {
  return manualDraftStorage.save(draft);
}

/** Reserve one idempotent manual submission until the form is edited. */
export function reserveManualBookSubmission(draft: ManualBookDraft): ManualBookDraft {
  if (draft.requestId && draft.submittedAt) return draft;
  const stableTitle = draft.title.trim() || resolveManualBookTitle('', normalizeManualContent(draft.content), new Date());
  return { ...draft, title: stableTitle, requestId: createRequestId(), submittedAt: new Date().toISOString() };
}

/** Drop the previous submission receipt when a meaningful form field changes. */
export function updateManualBookDraft(previous: ManualBookDraft, next: ManualBookDraft): ManualBookDraft {
  const fields: Array<keyof ManualBookDraft> = ['content', 'author', 'title', 'tags', 'sourceUrl', 'description', 'publicationStatus'];
  if (fields.some((field) => previous[field] !== next[field])) {
    return { ...next, requestId: undefined, submittedAt: undefined };
  }
  return { ...next, requestId: previous.requestId, submittedAt: previous.submittedAt };
}

export function clearManualBookDraft(): boolean {
  return manualDraftStorage.clear();
}

/** A read retry can restore old content without discarding newer form edits. */
export function mergeRecoveredManualBookDraft(current: ManualBookDraft, baseline: ManualBookDraft, recovered: ManualBookDraft): ManualBookDraft {
  const fields = ['content', 'author', 'title', 'tags', 'sourceUrl', 'description', 'publicationStatus'] as const;
  const edits = Object.fromEntries(fields.filter((field) => current[field] !== baseline[field]).map((field) => [field, current[field]]));
  return updateManualBookDraft(recovered, { ...recovered, ...edits });
}

export function prepareManualBook(draft: ManualBookDraft, now = new Date()): PreparedManualBook {
  const content = normalizeManualContent(draft.content);
  const title = resolveManualBookTitle(draft.title, content, now);
  const tags = parseManualBookTags(draft.tags);
  const metadata: UploadBookMetadata = { title };
  const author = draft.author.trim();
  const description = draft.description.trim();
  const sourceUrl = draft.sourceUrl.trim();

  if (author) metadata.author = author;
  if (description) metadata.description = description;
  metadata.publicationStatus = draft.publicationStatus;
  if (sourceUrl) metadata.sourceUrl = sourceUrl;
  if (tags.length > 0) metadata.tags = tags;

  return {
    file: new File([`${content}\n`], `${sanitizeManualFileName(title)}.txt`, { type: 'text/plain;charset=utf-8' }),
    metadata,
    title,
  };
}

export function resolveManualBookTitle(rawTitle: string, content: string, now = new Date()): string {
  const title = rawTitle.trim();
  if (title) return title;

  const firstLine = content.split('\n').map((line) => line.trim()).find(Boolean);
  if (firstLine && firstLine.length <= 60) return firstLine;

  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `手动文章 ${now.getFullYear()}-${month}-${day}`;
}

export function parseManualBookTags(value: string): string[] {
  return Array.from(new Set(value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean)));
}

function normalizeManualContent(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function sanitizeManualFileName(value: string): string {
  const withoutControlCharacters = Array.from(value, (character) => (character.charCodeAt(0) < 32 ? ' ' : character)).join('');
  const safeName = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return safeName || '手动文章';
}

function getManualBookDraftStorageKey(): string {
  const userId = getStoredSession()?.id;
  return userId ? `${MANUAL_BOOK_DRAFT_STORAGE_KEY}:${userId}` : MANUAL_BOOK_DRAFT_STORAGE_KEY;
}
