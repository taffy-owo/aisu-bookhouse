import { Link, useLocation } from 'react-router-dom';
import { getBookDetailPath, ROUTES } from '../../../config/routes';
import { createCollectionLinkState, getCollectionReturn, getCollectionReturnLabel } from '../../../shared/navigation/navigationState';

export function ReaderReturnLink({ bookId, toCollection = false }: { bookId?: string; toCollection?: boolean }) {
  const location = useLocation();
  const collection = getCollectionReturn(location.state);
  const returnsToCollection = toCollection || !bookId;
  const destination = returnsToCollection ? collection ? collection.pathname + collection.search : ROUTES.library : getBookDetailPath(bookId);
  const state = returnsToCollection ? collection ? { restoreNavigationKey: collection.key } : undefined : createCollectionLinkState(location);
  const collectionLabel = getCollectionReturnLabel(collection?.pathname ?? ROUTES.library);
  const label = returnsToCollection ? collectionLabel : '返回图书详情';
  return <Link className="reader-state-return reader-muted inline-flex min-h-11 items-center text-sm underline decoration-current/40 underline-offset-4 hover:text-[color:var(--reader-accent)]" state={state} to={destination}>{label}</Link>;
}
