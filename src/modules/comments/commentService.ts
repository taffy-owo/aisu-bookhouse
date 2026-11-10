import { apiRequest } from '../../shared/api';
import type { CommentTargetType, PublicComment } from './types';
import { invalidateBookListCache } from '../books/services/bookService';

export const PUBLIC_COMMENTS_CHANGED_EVENT = 'aisu:public-comments-changed';

function announceCommentChange(bookId: string, delta: number): void {
  invalidateBookListCache();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PUBLIC_COMMENTS_CHANGED_EVENT, { detail: { bookId, delta } }));
}

type BackendPublicComment = {
  id: string;
  book_id: string;
  user_id: string;
  user_nickname: string;
  target_type: CommentTargetType;
  target_index: number | null;
  body: string;
  created_at: string;
  updated_at: string;
};

type BackendPublicCommentListResponse = {
  items: BackendPublicComment[];
  total: number;
};

export type PublicCommentPage = { items: PublicComment[]; total: number };

export async function getPublicComments(
  bookId: string,
  targetType: CommentTargetType,
  targetIndex?: number,
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<PublicCommentPage> {
  const searchParams = new URLSearchParams({ target_type: targetType });
  if (targetIndex !== undefined) {
    searchParams.set('target_index', String(targetIndex));
  }
  if (options.offset !== undefined) searchParams.set('offset', String(options.offset));
  if (options.limit !== undefined) searchParams.set('limit', String(options.limit));
  const response = await apiRequest<BackendPublicCommentListResponse>(`/books/${bookId}/comments?${searchParams.toString()}`, { signal: options.signal });
  return { items: response.items.map(mapBackendComment), total: response.total };
}

export async function createPublicComment(bookId: string, input: { body: string; targetIndex?: number; targetType: CommentTargetType }, signal?: AbortSignal): Promise<PublicComment> {
  const comment = mapBackendComment(await apiRequest<BackendPublicComment>(`/books/${bookId}/comments`, {
    body: JSON.stringify({
      body: input.body,
      target_index: input.targetIndex,
      target_type: input.targetType,
    }),
    method: 'POST',
    ...(signal ? { signal } : {}),
  }));
  announceCommentChange(bookId, 1);
  return comment;
}

export async function deletePublicComment(bookId: string, commentId: string, signal?: AbortSignal): Promise<void> {
  await apiRequest<void>(`/books/${bookId}/comments/${commentId}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
  announceCommentChange(bookId, -1);
}

function mapBackendComment(comment: BackendPublicComment): PublicComment {
  return {
    id: comment.id,
    bookId: comment.book_id,
    userId: comment.user_id,
    userNickname: comment.user_nickname,
    targetType: comment.target_type,
    targetIndex: comment.target_index ?? undefined,
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}
