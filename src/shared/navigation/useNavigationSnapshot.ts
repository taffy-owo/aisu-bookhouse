import { useMemo } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { useSession } from '../../app/SessionContext';
import { getRestorationSnapshot, readNavigationSnapshot } from './navigationState';

export function useNavigationSnapshot() {
  const location = useLocation();
  const action = useNavigationType();
  const { session } = useSession();
  const scope = session?.id ?? 'anonymous';
  // Freeze the restoration target for this entry while scroll events update its saved position.
  return useMemo(() => readNavigationSnapshot(scope, location.key, location.pathname + location.search)
    ?? getRestorationSnapshot(scope, location, action), [action, location, scope]);
}
