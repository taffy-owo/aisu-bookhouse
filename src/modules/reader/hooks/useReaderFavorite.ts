import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../../../app/SessionContext';
import { getAccountScope } from '../../../shared/api';
import { setBookFavorite, type Book } from '../../books';
import { createReaderFavoriteController } from '../services/readerFavoriteController';

export function useReaderFavorite(book: Book) {
  const { session } = useSession();
  const accountId = session?.id;
  const { id, favorite, isOwned } = book;
  const controller = useMemo(() => createReaderFavoriteController({ id, favorite, isOwned }, setBookFavorite,
    getAccountScope, JSON.stringify(accountId ?? null)), [accountId, id, favorite, isOwned]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => () => controller.reset(), [controller]);
  return { controller, state };
}
