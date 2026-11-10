import type { Location } from 'react-router-dom';

export function createLocationResetKey(location: Pick<Location, 'hash' | 'pathname' | 'search'>): string {
  return `${location.pathname}${location.search}${location.hash}`;
}
