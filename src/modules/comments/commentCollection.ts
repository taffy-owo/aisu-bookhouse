import type { PublicCommentPage } from './commentService';
import type { PublicComment } from './types';

export interface CommentCollection {
  loaded: PublicComment[];
  posted: PublicComment[];
  total: number;
}

export const EMPTY_COMMENT_COLLECTION: CommentCollection = { loaded: [], posted: [], total: 0 };

/** Fetch the complete previously opened prefix before replacing visible comments. */
export async function loadCommentWindow(loadPage: (offset: number) => Promise<PublicCommentPage>, loadedCount: number, signal: AbortSignal): Promise<PublicCommentPage> {
  signal.throwIfAborted();
  const first = await loadPage(0);
  signal.throwIfAborted();
  const items = [...first.items];
  const ids = new Set(items.map((item) => item.id));
  while (items.length < loadedCount && items.length < first.total) {
    const page = await loadPage(items.length);
    signal.throwIfAborted();
    if (page.total !== first.total || !page.items.length || page.items.some((item) => ids.has(item.id))) {
      throw new Error('评论列表正在变化，请重试加载。');
    }
    page.items.forEach((item) => ids.add(item.id));
    items.push(...page.items);
  }
  return { items, total: first.total };
}

export function getCommentCollectionItems(collection: CommentCollection): PublicComment[] {
  return [...new Map([...collection.loaded, ...collection.posted].map((comment) => [comment.id, comment])).values()];
}

/** Keep new tail comments separate from the contiguous prefix used by offset pagination. */
export function applyCommentPage(collection: CommentCollection, page: PublicCommentPage, append = false): CommentCollection {
  const loaded = append ? [...collection.loaded, ...page.items] : page.items;
  const ids = new Set(loaded.map((comment) => comment.id));
  return { loaded, posted: collection.posted.filter((comment) => !ids.has(comment.id)), total: page.total };
}

export function addCreatedComment(collection: CommentCollection, comment: PublicComment): CommentCollection {
  if (getCommentCollectionItems(collection).some((item) => item.id === comment.id)) return collection;
  return { ...collection, posted: [...collection.posted, comment], total: collection.total + 1 };
}

export function removeDeletedComment(collection: CommentCollection, id: string): CommentCollection {
  if (!getCommentCollectionItems(collection).some((item) => item.id === id)) return collection;
  return {
    loaded: collection.loaded.filter((comment) => comment.id !== id),
    posted: collection.posted.filter((comment) => comment.id !== id),
    total: Math.max(0, collection.total - 1),
  };
}

export function hasCommentPageDrift(collection: CommentCollection, page: PublicCommentPage): boolean {
  return page.total !== collection.total || !page.items.length
    || page.items.some((item) => collection.loaded.some((loaded) => loaded.id === item.id));
}
