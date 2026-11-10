import type { Location, NavigationType } from 'react-router-dom';

export interface NavigationSnapshot {
  key: string;
  url: string;
  y: number;
  pages: number;
  anchor?: { bookId: string; offset: number };
  expandedSeriesBookId?: string;
  rails?: Record<string, number>;
}

export interface CollectionReturn {
  pathname: '/' | '/library' | '/public' | '/japanese' | '/me';
  search: string;
  key: string;
}

const STORAGE_KEY = 'aisu-bookhouse:navigation';
const MAX_ENTRIES = 40;
let activeScope: string | undefined;
let snapshots: NavigationSnapshot[] = [];

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validSnapshot(value: unknown): value is NavigationSnapshot {
  if (!value || typeof value !== 'object') return false;
  const entry = value as NavigationSnapshot;
  return validKey(entry.key) && typeof entry.url === 'string' && entry.url.startsWith('/') && !entry.url.startsWith('//')
    && entry.url.length <= 4096 && Number.isFinite(entry.y) && entry.y >= 0 && entry.y <= 10_000_000
    && Number.isInteger(entry.pages) && entry.pages >= 1 && entry.pages <= 100
    && (entry.rails === undefined || (entry.rails !== null && typeof entry.rails === 'object' && !Array.isArray(entry.rails)
      && Object.keys(entry.rails).length <= 16 && Object.entries(entry.rails).every(([name, offset]) => /^[a-z][a-z0-9-]{0,63}$/.test(name)
        && Number.isFinite(offset) && offset >= 0 && offset <= 10_000_000)))
    && (entry.expandedSeriesBookId === undefined || (typeof entry.expandedSeriesBookId === 'string' && entry.expandedSeriesBookId.length <= 200))
    && (entry.anchor === undefined || (typeof entry.anchor?.bookId === 'string' && entry.anchor.bookId.length <= 200
      && Number.isFinite(entry.anchor.offset) && Math.abs(entry.anchor.offset) <= 5000));
}

function selectScope(scope: string) {
  if (activeScope === scope) return;
  activeScope = scope;
  snapshots = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.scope === scope && Array.isArray(saved.entries)) snapshots = saved.entries.filter(validSnapshot).slice(-MAX_ENTRIES);
  } catch { /* Navigation remains available when tab storage is disabled. */ }
}

export function readNavigationSnapshot(scope: string, key: string, url: string) {
  selectScope(scope);
  return snapshots.find((entry) => entry.key === key && entry.url === url);
}

export function saveNavigationSnapshot(scope: string, entry: NavigationSnapshot) {
  if (!validSnapshot(entry)) return;
  selectScope(scope);
  snapshots = [...snapshots.filter((saved) => saved.key !== entry.key), { ...entry }].slice(-MAX_ENTRIES);
}

export function persistNavigationSnapshots() {
  if (activeScope === undefined) return;
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ scope: activeScope, entries: snapshots })); } catch { /* Best effort. */ }
}

export function getCollectionReturn(state: unknown): CollectionReturn | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as { collectionReturn?: CollectionReturn }).collectionReturn;
  if (!value || !['/', '/library', '/public', '/japanese', '/me'].includes(value.pathname) || !validKey(value.key)
    || typeof value.search !== 'string' || value.search.length > 4096 || (value.search !== '' && !value.search.startsWith('?'))
    || /[\r\n#]/.test(value.search)) return undefined;
  return { pathname: value.pathname, search: value.search, key: value.key };
}

export function createCollectionLinkState(location: Pick<Location, 'pathname' | 'search' | 'key' | 'state'>) {
  const collectionReturn = location.pathname === '/' || location.pathname === '/library' || location.pathname === '/public' || location.pathname === '/japanese' || location.pathname === '/me'
    ? { pathname: location.pathname, search: location.search, key: location.key } as CollectionReturn
    : getCollectionReturn(location.state);
  return collectionReturn ? { collectionReturn } : undefined;
}

export function getCollectionReturnLabel(pathname: CollectionReturn['pathname']) {
  return {
    '/': '返回首页',
    '/library': '返回书架',
    '/public': '返回公共书库',
    '/japanese': '返回日文书架',
    '/me': '返回个人中心',
  }[pathname];
}

export function getRestorationSnapshot(scope: string, location: Location, action: NavigationType) {
  const url = location.pathname + location.search;
  if (action === 'POP') {
    const ownEntry = readNavigationSnapshot(scope, location.key, url);
    if (ownEntry) return ownEntry;
  }
  const restoreKey: unknown = location.state?.restoreNavigationKey;
  return validKey(restoreKey) ? readNavigationSnapshot(scope, restoreKey, url) : undefined;
}

export function isViewOnlyNavigation(previousUrl: string, nextUrl: string) {
  const previous = new URL(previousUrl, 'https://navigation.invalid');
  const next = new URL(nextUrl, 'https://navigation.invalid');
  if (previous.pathname !== '/library' || next.pathname !== '/library') return false;
  previous.searchParams.delete('view');
  next.searchParams.delete('view');
  return previous.href === next.href;
}
