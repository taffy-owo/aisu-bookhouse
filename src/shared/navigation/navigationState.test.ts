import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationType, type Location } from 'react-router-dom';

const storage = new Map<string, string>();
const STORAGE_KEY = 'aisu-bookhouse:navigation';
const location = (state: unknown = null, search = '?kind=manga'): Location => ({ pathname: '/library', key: 'shelf-entry', search, hash: '', state });

beforeEach(() => {
  vi.resetModules();
  storage.clear();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});

describe('collection navigation continuity', () => {
  it('retains the source collection through detail and reader links', async () => {
    const { createCollectionLinkState, getCollectionReturn } = await import('./navigationState');
    const state = createCollectionLinkState(location());
    expect(getCollectionReturn(state)).toEqual({ pathname: '/library', search: '?kind=manga', key: 'shelf-entry' });
    expect(createCollectionLinkState({ ...location(), pathname: '/reader/novel/book', state })).toEqual(state);
    expect(createCollectionLinkState({ ...location(), pathname: '/public' })?.collectionReturn.pathname).toBe('/public');
  });

  it('rejects unsupported return routes, malformed keys, and URL fragments', async () => {
    const { getCollectionReturn } = await import('./navigationState');
    for (const entry of [null, { pathname: '//other.site', search: '', key: 'a' }, { pathname: '/settings', search: '', key: 'a' }, { pathname: '/library', search: 'bad', key: 'a' }, { pathname: '/library', search: '?q=x#y', key: 'a' }, { pathname: '/library', search: '', key: '' }]) {
      expect(getCollectionReturn({ collectionReturn: entry })).toBeUndefined();
    }
  });

  it('retains Japanese shelf filters and the loaded pages through detail and reader returns', async () => {
    const { createCollectionLinkState, getCollectionReturn, getRestorationSnapshot, saveNavigationSnapshot } = await import('./navigationState');
    const source: Location = { ...location(), pathname: '/japanese', search: '?q=雨&shelf=unread' };
    const state = createCollectionLinkState(source);
    expect(getCollectionReturn(state)).toEqual({ pathname: '/japanese', search: source.search, key: source.key });
    expect(createCollectionLinkState({ ...source, pathname: '/reader/novel/book', state })).toEqual(state);
    saveNavigationSnapshot('alice', { key: source.key, url: source.pathname + source.search, y: 2100, pages: 2 });
    expect(getRestorationSnapshot('alice', source, NavigationType.Pop)?.pages).toBe(2);
    expect(getRestorationSnapshot('alice', { ...source, key: 'return', state: { restoreNavigationKey: source.key } }, NavigationType.Push)?.y).toBe(2100);
  });

  it.each([
    { pathname: '/', label: '返回首页' },
    { pathname: '/me', label: '返回个人中心' },
  ])('returns to $pathname through detail and reader links', async ({ pathname, label }) => {
    const { createCollectionLinkState, getCollectionReturn, getCollectionReturnLabel, getRestorationSnapshot, saveNavigationSnapshot } = await import('./navigationState');
    const source: Location = { ...location(), pathname, search: '', key: 'reading-source' };
    const state = createCollectionLinkState(source);
    const detail = { ...source, pathname: '/books/book', state };
    const readerState = createCollectionLinkState(detail);
    expect(getCollectionReturn(readerState)).toEqual({ pathname, search: '', key: source.key });
    expect(createCollectionLinkState({ ...detail, pathname: '/reader/novel/book', state: readerState })).toEqual(state);
    expect(getCollectionReturnLabel(getCollectionReturn(readerState)!.pathname)).toBe(label);
    const saved = { key: source.key, url: pathname, y: 480, pages: 1, rails: { 'recent-reading': 962 } };
    saveNavigationSnapshot('alice', saved);
    expect(getRestorationSnapshot('alice', { ...source, key: 'returned', state: { restoreNavigationKey: source.key } }, NavigationType.Push)).toEqual(saved);
  });

  it('restores POP entries and explicit collection returns, and resets new visits', async () => {
    const { getRestorationSnapshot, saveNavigationSnapshot } = await import('./navigationState');
    const entry = { key: 'shelf-entry', url: '/library?kind=manga', y: 2700, pages: 3 };
    saveNavigationSnapshot('alice', entry);
    expect(getRestorationSnapshot('alice', location(), NavigationType.Pop)).toEqual(entry);
    expect(getRestorationSnapshot('alice', location(), NavigationType.Push)).toBeUndefined();
    expect(getRestorationSnapshot('alice', { ...location({ restoreNavigationKey: 'shelf-entry' }), key: 'new-entry' }, NavigationType.Push)).toEqual(entry);
    expect(getRestorationSnapshot('alice', location(null, '?kind=novel'), NavigationType.Pop)).toBeUndefined();
    saveNavigationSnapshot('alice', { ...entry, key: 'new-entry', y: 5000, pages: 4 });
    expect(getRestorationSnapshot('alice', { ...location({ restoreNavigationKey: 'shelf-entry' }), key: 'new-entry' }, NavigationType.Pop)?.y).toBe(5000);
  });

  it('isolates accounts and bounds stored history', async () => {
    const { readNavigationSnapshot, saveNavigationSnapshot, persistNavigationSnapshots } = await import('./navigationState');
    for (let i = 0; i < 50; i++) saveNavigationSnapshot('alice', { key: `entry-${i}`, url: '/library', y: i * 100, pages: 1 });
    persistNavigationSnapshots();
    expect(JSON.parse(storage.get(STORAGE_KEY)!).entries).toHaveLength(40);
    expect(readNavigationSnapshot('alice', 'entry-0', '/library')).toBeUndefined();
    expect(readNavigationSnapshot('alice', 'entry-49', '/library')?.y).toBe(4900);
    expect(readNavigationSnapshot('bob', 'entry-49', '/library')).toBeUndefined();
  });

  it('restores horizontal reading shelves with their own history entry after storage reload', async () => {
    const first = await import('./navigationState');
    first.saveNavigationSnapshot('alice', { key: 'home-entry', url: '/', y: 480, pages: 1, rails: { 'recent-reading': 962 } });
    first.persistNavigationSnapshots();
    vi.resetModules();
    const { getRestorationSnapshot } = await import('./navigationState');
    const home = { ...location(), pathname: '/', search: '', key: 'home-entry' };
    expect(getRestorationSnapshot('alice', home, NavigationType.Pop)?.rails).toEqual({ 'recent-reading': 962 });
    expect(getRestorationSnapshot('alice', { ...home, key: 'new-home' }, NavigationType.Push)).toBeUndefined();
    expect(getRestorationSnapshot('bob', home, NavigationType.Pop)).toBeUndefined();
  });

  it('ignores malformed persisted horizontal positions while accepting older snapshots', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({ scope: 'alice', entries: [
      { key: 'legacy', url: '/', y: 20, pages: 1 },
      ...[null, [], { 'recent-reading': -1 }, { 'recent-reading': '20' }, { 'recent-reading': 10000001 }, { 'bad key': 20 }].map((rails, index) => ({ key: `bad-${index}`, url: '/', y: 20, pages: 1, rails })),
    ] }));
    const { readNavigationSnapshot } = await import('./navigationState');
    expect(readNavigationSnapshot('alice', 'legacy', '/')?.y).toBe(20);
    for (let index = 0; index < 6; index++) expect(readNavigationSnapshot('alice', `bad-${index}`, '/')).toBeUndefined();
  });

  it('recovers valid persisted entries and ignores corrupt storage', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({ scope: 'alice', entries: [
      { key: 'ok', url: '/public?q=春', y: 900, pages: 2 },
      { key: 'bad', url: '/public', y: -1, pages: 0 },
      { key: 'oversized', url: '/public', y: 5, pages: 1_000_000 },
    ] }));
    const { readNavigationSnapshot } = await import('./navigationState');
    expect(readNavigationSnapshot('alice', 'ok', '/public?q=春')?.pages).toBe(2);
    expect(readNavigationSnapshot('alice', 'bad', '/public')).toBeUndefined();
    expect(readNavigationSnapshot('alice', 'oversized', '/public')).toBeUndefined();
    storage.set(STORAGE_KEY, '{bad json');
    expect(readNavigationSnapshot('bob', 'ok', '/public?q=春')).toBeUndefined();
  });

  it('still works in memory when tab storage throws', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    const { readNavigationSnapshot, saveNavigationSnapshot, persistNavigationSnapshots } = await import('./navigationState');
    saveNavigationSnapshot('alice', { key: 'entry', url: '/library', y: 600, pages: 2 });
    expect(() => persistNavigationSnapshots()).not.toThrow();
    expect(readNavigationSnapshot('alice', 'entry', '/library')?.y).toBe(600);
  });

  it('preserves position only for view changes, while filters start a fresh list', async () => {
    const { isViewOnlyNavigation } = await import('./navigationState');
    expect(isViewOnlyNavigation('/library?kind=manga', '/library?kind=manga&view=list')).toBe(true);
    expect(isViewOnlyNavigation('/library?kind=manga', '/library?kind=novel&view=list')).toBe(false);
    expect(isViewOnlyNavigation('/public', '/library?view=list')).toBe(false);
  });
});
