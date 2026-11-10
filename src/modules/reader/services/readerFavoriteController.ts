import { getAccountScope } from '../../../shared/api';
import type { Book } from '../../books';

type FavoriteBook = Pick<Book, 'id' | 'favorite' | 'isOwned'>;
type FavoriteApi = (bookId: string, favorite: boolean) => Promise<FavoriteBook>;
export interface ReaderFavoriteState { favorite: boolean; isSaving: boolean; message: string }
const EMPTY_FAVORITE_STATE: ReaderFavoriteState = { favorite: false, isSaving: false, message: '' };

export function createReaderFavoriteController(
  book: FavoriteBook,
  save: FavoriteApi,
  readScope = getAccountScope,
  scope = readScope(),
) {
  const initial = (): ReaderFavoriteState => ({ favorite: Boolean(book.favorite), isSaving: false, message: '' });
  let state = initial();
  let generation = 0;
  let messageTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ReaderFavoriteState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const clearMessageTimer = () => {
    if (messageTimer !== null) clearTimeout(messageTimer);
    messageTimer = null;
  };
  const isCurrent = (request: number) => request === generation && scope === readScope();
  const showMessage = (message: string, request: number) => {
    clearMessageTimer();
    publish({ message });
    messageTimer = setTimeout(() => {
      messageTimer = null;
      if (isCurrent(request)) publish({ message: '' });
    }, 2200);
  };

  return {
    getSnapshot: () => scope === readScope() ? state : EMPTY_FAVORITE_STATE,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset: () => {
      generation += 1;
      clearMessageTimer();
      state = initial();
      listeners.forEach((listener) => listener());
    },
    toggle: async (): Promise<boolean> => {
      if (!book.isOwned || state.isSaving || scope !== readScope()) return false;
      const request = generation;
      const nextFavorite = !state.favorite;
      clearMessageTimer();
      publish({ isSaving: true, message: '' });
      try {
        const confirmed = await save(book.id, nextFavorite);
        if (!isCurrent(request)) return false;
        if (confirmed.id !== book.id) throw new Error('收藏结果与当前图书不一致');
        publish({ favorite: Boolean(confirmed.favorite) });
        showMessage(confirmed.favorite ? '已加入收藏' : '已取消收藏', request);
        return true;
      } catch (error: unknown) {
        if (isCurrent(request)) showMessage(error instanceof Error ? error.message : '收藏更新失败', request);
        return false;
      } finally {
        if (isCurrent(request)) publish({ isSaving: false });
      }
    },
  };
}
